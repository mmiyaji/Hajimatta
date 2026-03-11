
const WebSocket = require("ws");
const fs = require("node:fs");
const path = require("node:path");

const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const TWITCH_API_BASE_URL = "https://api.twitch.tv/helix";
const TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const SUBSCRIPTION_TYPES = ["stream.online", "channel.update"];
const MAX_BROADCASTERS = 5;

const env = loadEnv();
const broadcasterLogins = parseBroadcasterLogins(env.TWITCH_BROADCASTERS);
const stateFile = path.resolve(process.cwd(), env.STATE_FILE || "./data/state.json");

if (!env.TWITCH_CLIENT_ID) throw new Error("TWITCH_CLIENT_ID is required.");
if (!env.TWITCH_ACCESS_TOKEN) throw new Error("TWITCH_ACCESS_TOKEN is required.");
if (!env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL is required.");
if (broadcasterLogins.length === 0) throw new Error("TWITCH_BROADCASTERS must contain at least one login.");
if (broadcasterLogins.length > MAX_BROADCASTERS) {
  throw new Error(`TWITCH_BROADCASTERS supports up to ${MAX_BROADCASTERS} broadcasters with current EventSub settings.`);
}

const config = {
  twitchClientId: env.TWITCH_CLIENT_ID,
  twitchClientSecret: env.TWITCH_CLIENT_SECRET || "",
  twitchAccessToken: env.TWITCH_ACCESS_TOKEN,
  twitchRefreshToken: env.TWITCH_REFRESH_TOKEN || "",
  slackWebhookUrl: env.SLACK_WEBHOOK_URL,
  reconnectDelayMs: 5000,
  liveReconcileIntervalMs: Number.parseInt(env.LIVE_RECONCILE_INTERVAL_MS || "120000", 10),
  authAlertIntervalMs: Number.parseInt(env.TWITCH_AUTH_ALERT_INTERVAL_MS || "7200000", 10),
};

const state = { broadcasters: {}, meta: seedStateMeta() };
const seenMessageIds = new Set();
let websocket = null;
let keepaliveTimer = null;
let keepaliveTimeoutSeconds = 10;
let reconnectTimer = null;
let refreshInFlight = null;
let resolvedBroadcasters = [];
let intentionalClose = false;
let liveReconcileTimer = null;

main().catch((error) => {
  log("fatal", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  ensureStateDirectory(stateFile);
  const initialState = loadState(stateFile, []);
  state.broadcasters = initialState.broadcasters;
  state.meta = initialState.meta;
  await ensureValidUserAccessToken();
  resolvedBroadcasters = await resolveBroadcasters(broadcasterLogins);
  if (resolvedBroadcasters.length === 0) {
    throw new Error("No broadcasters could be resolved from TWITCH_BROADCASTERS.");
  }

  const hydratedState = loadState(stateFile, resolvedBroadcasters);
  state.broadcasters = hydratedState.broadcasters;
  state.meta = hydratedState.meta;
  log("info", `Resolved ${resolvedBroadcasters.length} broadcasters`);
  await hydrateInitialState();
  await cleanupManagedSubscriptions();
  await connect(EVENTSUB_WS_URL);
  startLiveReconcileLoop();
}

async function connect(url) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  log("info", `Connecting to Twitch EventSub: ${url}`);
  const socket = new WebSocket(url);
  websocket = socket;

  socket.on("open", () => {
    if (socket !== websocket) return;
    log("info", "WebSocket connected");
  });

  socket.on("message", async (data) => {
    if (socket !== websocket) return;

    try {
      const payload = JSON.parse(String(data));
      await handleMessage(payload);
    } catch (error) {
      log("error", error instanceof Error ? error.stack || error.message : String(error));
    }
  });

  socket.on("close", () => {
    if (socket !== websocket) return;
    log("warn", "WebSocket closed");
    clearKeepaliveTimer();
    if (intentionalClose) {
      intentionalClose = false;
      return;
    }
    scheduleReconnect();
  });

  socket.on("error", (error) => {
    if (socket !== websocket) return;
    log("error", error?.message || "WebSocket error");
  });
}

async function handleMessage(payload) {
  const metadata = payload.metadata || {};
  const messageType = metadata.message_type;
  const messageId = metadata.message_id;
  const keepaliveSeconds = payload.payload?.session?.keepalive_timeout_seconds;

  if (keepaliveSeconds) {
    keepaliveTimeoutSeconds = keepaliveSeconds;
    resetKeepaliveTimeout(keepaliveTimeoutSeconds);
  }

  if (messageId) {
    if (seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
    if (seenMessageIds.size > 1000) {
      const oldest = seenMessageIds.values().next().value;
      seenMessageIds.delete(oldest);
    }
  }

  switch (messageType) {
    case "session_welcome":
      await registerSubscriptions(payload.payload.session.id);
      return;
    case "session_keepalive":
      resetKeepaliveTimeout(keepaliveTimeoutSeconds);
      return;
    case "session_reconnect":
      await reconnectTo(payload.payload.session.reconnect_url);
      return;
    case "notification":
      await handleNotification(payload.payload.subscription, payload.payload.event);
      return;
    case "revocation":
      log("warn", `Subscription revoked: ${payload.payload.subscription.type} (${payload.payload.subscription.status})`);
      return;
    default:
      log("info", `Unhandled message type: ${messageType || "unknown"}`);
  }
}

async function registerSubscriptions(sessionId) {
  const total = resolvedBroadcasters.length * SUBSCRIPTION_TYPES.length;
  log("info", `Registering ${total} subscriptions on session ${sessionId}`);

  for (const broadcaster of resolvedBroadcasters) {
    for (const type of SUBSCRIPTION_TYPES) {
      await createSubscription(type, broadcaster.id, sessionId);
    }
  }
}

async function cleanupManagedSubscriptions() {
  const response = await twitchFetch(
    `${TWITCH_API_BASE_URL}/eventsub/subscriptions`,
    { headers: twitchHeaders() },
    { retryOnUnauthorized: true }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list EventSub subscriptions: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const subscriptions = payload.data || [];
  const managedTypes = new Set(SUBSCRIPTION_TYPES);
  const managedBroadcasterIds = new Set(resolvedBroadcasters.map((b) => b.id));

  for (const subscription of subscriptions) {
    if (subscription.transport?.method !== "websocket") continue;
    if (!managedTypes.has(subscription.type)) continue;
    if (!managedBroadcasterIds.has(subscription.condition?.broadcaster_user_id)) continue;

    const deleteResponse = await twitchFetch(
      `${TWITCH_API_BASE_URL}/eventsub/subscriptions?id=${subscription.id}`,
      { method: "DELETE", headers: twitchHeaders() },
      { retryOnUnauthorized: true }
    );

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const text = await deleteResponse.text();
      throw new Error(`Failed to delete EventSub subscription ${subscription.id}: ${deleteResponse.status} ${text}`);
    }

    log("info", `Deleted stale subscription: ${subscription.type}:${subscription.condition?.broadcaster_user_id}`);
  }
}

async function createSubscription(type, broadcasterUserId, sessionId) {
  const response = await twitchFetch(
    `${TWITCH_API_BASE_URL}/eventsub/subscriptions`,
    {
      method: "POST",
      headers: twitchHeaders(),
      body: JSON.stringify({
        type,
        version: "1",
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: "websocket", session_id: sessionId },
      }),
    },
    { retryOnUnauthorized: true }
  );

  if (response.status === 409) {
    log("info", `Subscription already exists: ${type}:${broadcasterUserId}`);
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create subscription ${type}:${broadcasterUserId}: ${response.status} ${text}`);
  }

  log("info", `Subscribed: ${type}:${broadcasterUserId}`);
}

async function reconnectTo(url) {
  log("info", `Reconnect requested by Twitch: ${url}`);
  clearKeepaliveTimer();
  const previousSocket = websocket;
  intentionalClose = true;
  await connect(url);
  if (previousSocket && previousSocket !== websocket) previousSocket.close();
}
async function ensureValidUserAccessToken() {
  let validation = await validateUserAccessToken();
  if (!validation.ok) {
    if (!config.twitchRefreshToken) {
      throw new Error(`TWITCH_ACCESS_TOKEN is invalid and TWITCH_REFRESH_TOKEN is missing. ${validation.detail}`);
    }
    log("warn", `Access token invalid; refreshing token. ${validation.detail}`);
    await refreshUserAccessToken();
    validation = await validateUserAccessToken();
  }

  if (!validation.ok) {
    throw new Error(`TWITCH token validation failed after refresh. ${validation.detail}`);
  }
  if (validation.data.client_id !== config.twitchClientId) {
    throw new Error("TWITCH_ACCESS_TOKEN does not belong to TWITCH_CLIENT_ID.");
  }
  if (!validation.data.user_id || !validation.data.login) {
    throw new Error("TWITCH_ACCESS_TOKEN must be a User Access Token for EventSub WebSocket. App Access Tokens only work with webhook transport.");
  }

  clearAuthFailureNotice();
  log("info", `Validated user token for ${validation.data.login}`);
}

async function validateUserAccessToken() {
  const response = await fetch(TWITCH_VALIDATE_URL, {
    headers: { Authorization: `OAuth ${config.twitchAccessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, detail: `${response.status} ${text}` };
  }

  return { ok: true, data: await response.json() };
}

async function refreshUserAccessToken() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const response = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.twitchRefreshToken,
        client_id: config.twitchClientId,
        ...(config.twitchClientSecret ? { client_secret: config.twitchClientSecret } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let refreshError;
      if (!config.twitchClientSecret && text.includes("missing client secret")) {
        refreshError = new Error("Failed to refresh TWITCH_ACCESS_TOKEN: Twitch requires TWITCH_CLIENT_SECRET for this app. Add TWITCH_CLIENT_SECRET to .env or recreate the token with a public Device Code client.");
      } else {
        refreshError = new Error(`Failed to refresh TWITCH_ACCESS_TOKEN: ${response.status} ${text}`);
      }
      await notifyAuthFailure(refreshError);
      throw refreshError;
    }

    const token = await response.json();
    if (!token.access_token || !token.refresh_token) {
      throw new Error("Twitch refresh response did not include access_token and refresh_token.");
    }

    config.twitchAccessToken = token.access_token;
    config.twitchRefreshToken = token.refresh_token;
    process.env.TWITCH_ACCESS_TOKEN = token.access_token;
    process.env.TWITCH_REFRESH_TOKEN = token.refresh_token;
    saveEnvValue("TWITCH_ACCESS_TOKEN", token.access_token);
    saveEnvValue("TWITCH_REFRESH_TOKEN", token.refresh_token);
    clearAuthFailureNotice();
    log("info", "Refreshed Twitch user access token");
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function twitchFetch(url, options, settings = {}) {
  let response = await fetch(url, options);
  if (response.status === 401 && settings.retryOnUnauthorized) {
    if (!config.twitchRefreshToken) return response;

    await refreshUserAccessToken();
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...twitchHeaders(),
      },
    });
  }
  return response;
}

async function resolveBroadcasters(logins) {
  const unresolved = [...new Set(logins.map((login) => login.toLowerCase()))];
  const resolved = [];

  for (let index = 0; index < unresolved.length; index += 100) {
    const chunk = unresolved.slice(index, index + 100);
    const query = chunk.map((login) => `login=${encodeURIComponent(login)}`).join("&");
    const response = await twitchFetch(
      `${TWITCH_API_BASE_URL}/users?${query}`,
      { headers: twitchHeaders() },
      { retryOnUnauthorized: true }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to resolve broadcasters: ${response.status} ${text}`);
    }

    const json = await response.json();
    for (const user of json.data || []) {
      resolved.push({ id: user.id, login: user.login, displayName: user.display_name });
    }
  }

  const resolvedLogins = new Set(resolved.map((item) => item.login.toLowerCase()));
  const missing = unresolved.filter((login) => !resolvedLogins.has(login));
  if (missing.length > 0) {
    throw new Error(`Failed to resolve Twitch users: ${missing.join(", ")}`);
  }

  return resolved;
}

async function fetchLiveStreamsByLogin(logins) {
  if (logins.length === 0) return [];

  const query = logins.map((login) => `user_login=${encodeURIComponent(login)}`).join("&");
  const response = await twitchFetch(
    `${TWITCH_API_BASE_URL}/streams?${query}`,
    { headers: twitchHeaders() },
    { retryOnUnauthorized: true }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch streams: ${response.status} ${text}`);
  }

  const json = await response.json();
  return json.data || [];
}

async function fetchChannelInformationById(ids) {
  if (ids.length === 0) return [];

  const query = ids.map((id) => `broadcaster_id=${encodeURIComponent(id)}`).join("&");
  const response = await twitchFetch(
    `${TWITCH_API_BASE_URL}/channels?${query}`,
    { headers: twitchHeaders() },
    { retryOnUnauthorized: true }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch channel information: ${response.status} ${text}`);
  }

  const json = await response.json();
  return json.data || [];
}

async function hydrateInitialState() {
  const [streams, channels] = await Promise.all([
    fetchLiveStreamsByLogin(resolvedBroadcasters.map((broadcaster) => broadcaster.login)),
    fetchChannelInformationById(resolvedBroadcasters.map((broadcaster) => broadcaster.id)),
  ]);

  const streamsByLogin = new Map(streams.map((stream) => [stream.user_login, stream]));
  const channelsById = new Map(channels.map((channel) => [channel.broadcaster_id, channel]));
  let changed = false;
  let liveCount = 0;
  const liveSummaries = [];

  for (const broadcaster of resolvedBroadcasters) {
    const current = state.broadcasters[broadcaster.id] || seedBroadcaster(broadcaster);
    const liveStream = streamsByLogin.get(broadcaster.login);
    const channel = channelsById.get(broadcaster.id);
    const nextTitle = channel?.title || "";
    const nextCategoryId = channel?.game_id || "";
    const nextCategoryName = channel?.game_name || "";
    const nextLanguage = channel?.broadcaster_language || "";
    const nextLive = Boolean(liveStream);
    const nextStartedAt = liveStream?.started_at || null;
    const nextInitialUpdateNotified = nextLive;

    if (
      current.title !== nextTitle ||
      current.categoryId !== nextCategoryId ||
      current.categoryName !== nextCategoryName ||
      current.language !== nextLanguage ||
      current.live !== nextLive ||
      current.startedAt !== nextStartedAt ||
      current.initialUpdateNotified !== nextInitialUpdateNotified
    ) {
      current.title = nextTitle;
      current.categoryId = nextCategoryId;
      current.categoryName = nextCategoryName;
      current.language = nextLanguage;
      current.live = nextLive;
      current.startedAt = nextStartedAt;
      current.initialUpdateNotified = nextInitialUpdateNotified;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
    }

    if (nextLive) {
      liveCount += 1;
      liveSummaries.push(`login=${broadcaster.login} title=${nextTitle || "(empty)"} category=${nextCategoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
    }
  }

  if (changed) saveState(stateFile, state);
  log("info", `Hydrated initial state: broadcasters=${resolvedBroadcasters.length} live=${liveCount}`);
  if (liveSummaries.length > 0) {
    log("info", `Initial live broadcasters: ${liveSummaries.join(" | ")}`);
  }
}
function startLiveReconcileLoop() {
  if (liveReconcileTimer) clearInterval(liveReconcileTimer);
  log("info", `Starting live reconcile loop: intervalMs=${config.liveReconcileIntervalMs} intervalSec=${Math.round(config.liveReconcileIntervalMs / 1000)}`);
  liveReconcileTimer = setInterval(() => {
    reconcileLiveState().catch((error) => {
      log("error", error instanceof Error ? error.stack || error.message : String(error));
    });
  }, config.liveReconcileIntervalMs);
}

async function reconcileLiveState() {
  log("info", `Running live reconcile check for ${resolvedBroadcasters.length} broadcasters`);
  const streams = await fetchLiveStreamsByLogin(resolvedBroadcasters.map((b) => b.login));
  const streamsByLogin = new Map(streams.map((stream) => [stream.user_login, stream]));
  let changed = false;
  let reconciledOnline = 0;
  let reconciledOffline = 0;

  for (const broadcaster of resolvedBroadcasters) {
    const current = state.broadcasters[broadcaster.id] || seedBroadcaster(broadcaster);
    const liveStream = streamsByLogin.get(broadcaster.login);

    if (liveStream && !current.live) {
      current.live = true;
      current.startedAt = liveStream.started_at || null;
      current.initialUpdateNotified = false;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
      reconciledOnline += 1;
      log("info", `Live state reconciled online: login=${broadcaster.login} startedAt=${current.startedAt || "(unknown)"} url=${streamUrl(broadcaster.login)}`);
      continue;
    }

    if (!liveStream && current.live) {
      await postToSlack({
        text: headline(`${displayNameOf(current)} stream ended (confirmed)`),
        blocks: [sectionBlock([
          `*${displayNameOf(current)}* stream end confirmed by API reconcile.`,
          current.title ? `*Title*: ${escapeMrkdwn(current.title)}` : null,
          current.categoryName ? `*Category*: ${escapeMrkdwn(current.categoryName)}` : null,
          current.startedAt ? `*Started At*: ${escapeMrkdwn(current.startedAt)}` : null,
          `*URL*: ${streamUrl(current.login)}`,
        ].filter(Boolean).join("\n"))],
      });

      current.live = false;
      current.startedAt = null;
      current.initialUpdateNotified = false;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
      reconciledOffline += 1;
      log("info", `Live state reconciled offline: login=${broadcaster.login} url=${streamUrl(broadcaster.login)}`);
    }
  }

  if (changed) saveState(stateFile, state);
  log("info", `Live reconcile completed: currentLive=${streams.length} reconciledOnline=${reconciledOnline} reconciledOffline=${reconciledOffline} changed=${changed}`);
}
async function handleNotification(subscription, event) {
  switch (subscription.type) {
    case "stream.online":
      await handleStreamOnline(event);
      return;
    case "channel.update":
      await handleChannelUpdate(event);
      return;
    default:
      log("info", `Ignored event: ${subscription.type}`);
  }
}

async function handleStreamOnline(event) {
  const broadcaster = ensureBroadcasterState(event);
  broadcaster.live = true;
  broadcaster.startedAt = event.started_at || null;
  broadcaster.initialUpdateNotified = false;
  saveState(stateFile, state);

  await postToSlack({
    text: headline(`${displayNameOf(broadcaster)} started streaming`),
    blocks: [sectionBlock([
      `*${displayNameOf(broadcaster)}* が配信を開始しました。`,
      broadcaster.startedAt ? `*開始時刻*: ${escapeMrkdwn(broadcaster.startedAt)}` : null,
      `*URL*: ${streamUrl(broadcaster.login)}`,
    ].filter(Boolean).join("\n"))],
  });

  log("info", `Stream online detected: login=${broadcaster.login} title=${broadcaster.title || "(unknown)"} category=${broadcaster.categoryName || "(unknown)"} url=${streamUrl(broadcaster.login)}`);
}

async function handleChannelUpdate(event) {
  const broadcaster = ensureBroadcasterState(event);
  const previousTitle = broadcaster.title;
  const previousCategory = broadcaster.categoryName;

  broadcaster.title = event.title || "";
  broadcaster.categoryId = event.category_id || "";
  broadcaster.categoryName = event.category_name || "";
  broadcaster.language = event.language || "";
  saveState(stateFile, state);

  if (!broadcaster.live) {
    const titleChangedWhileOffline = previousTitle !== broadcaster.title;
    const categoryChangedWhileOffline = previousCategory !== broadcaster.categoryName;

    if (!titleChangedWhileOffline && !categoryChangedWhileOffline) {
      log("info", `Ignored offline channel.update: ${event.broadcaster_user_login}`);
      return;
    }

    await postToSlack({
      text: headline(`${displayNameOf(broadcaster)} stream prep detected`),
      blocks: [sectionBlock([
        `*${displayNameOf(broadcaster)}* ??????????????????`,
        titleChangedWhileOffline ? `*????*: ${escapeMrkdwn(previousTitle || "(empty)")} -> ${escapeMrkdwn(broadcaster.title || "(empty)")}` : null,
        categoryChangedWhileOffline ? `*?????*: ${escapeMrkdwn(previousCategory || "(empty)")} -> ${escapeMrkdwn(broadcaster.categoryName || "(empty)")}` : null,
        `*URL*: ${streamUrl(broadcaster.login)}`,
      ].filter(Boolean).join("\n"))],
    });

    log("info", `Pre-stream update detected: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
    return;
  }

  if (!broadcaster.initialUpdateNotified) {
    broadcaster.initialUpdateNotified = true;
    saveState(stateFile, state);

    await postToSlack({
      text: headline(`${displayNameOf(broadcaster)} stream details updated`),
      blocks: [sectionBlock([
        `*${displayNameOf(broadcaster)}* の配信情報を受信しました。`,
        broadcaster.title ? `*タイトル*: ${escapeMrkdwn(broadcaster.title)}` : null,
        broadcaster.categoryName ? `*カテゴリー*: ${escapeMrkdwn(broadcaster.categoryName)}` : null,
        `*URL*: ${streamUrl(broadcaster.login)}`,
      ].filter(Boolean).join("\n"))],
    });

    log("info", `Initial channel update notified: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
    return;
  }

  const titleChanged = previousTitle !== broadcaster.title;
  const categoryChanged = previousCategory !== broadcaster.categoryName;
  if (!titleChanged && !categoryChanged) return;

  await postToSlack({
    text: headline(`${displayNameOf(broadcaster)} updated stream settings`),
    blocks: [sectionBlock([
      `*${displayNameOf(broadcaster)}* の配信情報が更新されました。`,
      titleChanged ? `*タイトル*: ${escapeMrkdwn(previousTitle || "(empty)")} -> ${escapeMrkdwn(broadcaster.title || "(empty)")}` : null,
      categoryChanged ? `*カテゴリー*: ${escapeMrkdwn(previousCategory || "(empty)")} -> ${escapeMrkdwn(broadcaster.categoryName || "(empty)")}` : null,
      `*URL*: ${streamUrl(broadcaster.login)}`,
    ].filter(Boolean).join("\n"))],
  });

  log("info", `Channel update notified: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
}
async function postToSlack(payload) {
  const response = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook failed: ${response.status} ${text}`);
  }
}

function ensureBroadcasterState(event) {
  const broadcaster =
    state.broadcasters[event.broadcaster_user_id] ||
    Object.values(state.broadcasters).find((item) => item.login === event.broadcaster_user_login) ||
    resolvedBroadcasters.find((item) => item.id === event.broadcaster_user_id) ||
    {};

  broadcaster.id = event.broadcaster_user_id;
  broadcaster.login = event.broadcaster_user_login;
  broadcaster.displayName = event.broadcaster_user_name;
  broadcaster.title = broadcaster.title ?? "";
  broadcaster.categoryId = broadcaster.categoryId ?? "";
  broadcaster.categoryName = broadcaster.categoryName ?? "";
  broadcaster.language = broadcaster.language ?? "";
  broadcaster.live = broadcaster.live ?? false;
  broadcaster.initialUpdateNotified = broadcaster.initialUpdateNotified ?? false;
  broadcaster.startedAt = broadcaster.startedAt ?? null;

  state.broadcasters[event.broadcaster_user_id] = broadcaster;
  return broadcaster;
}

function loadEnv() {
  const result = { ...process.env };
  const envFilePath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFilePath)) return result;

  const lines = fs.readFileSync(envFilePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in result)) result[key] = value;
  }

  return result;
}

function saveEnvValue(key, value) {
  const envFilePath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFilePath)) return;

  const lines = fs.readFileSync(envFilePath, "utf8").split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) updated.push(`${key}=${value}`);
  fs.writeFileSync(envFilePath, updated.join("\n"));
}

async function notifyAuthFailure(error) {
  const now = Date.now();
  const authState = state.meta.auth.refreshFailure;
  const detail = error instanceof Error ? error.message : String(error);

  if (authState.lastNotifiedAt && now - authState.lastNotifiedAt < config.authAlertIntervalMs) {
    log("warn", `Auth failure notification suppressed: nextAllowedInMs=${config.authAlertIntervalMs - (now - authState.lastNotifiedAt)}`);
    return;
  }

  authState.lastNotifiedAt = now;
  authState.lastError = detail;
  saveState(stateFile, state);

  try {
    await postToSlack({
      text: headline("Twitch auth refresh failed"),
      blocks: [sectionBlock([
        "*Twitch token refresh failed.*",
        `*Time*: ${escapeMrkdwn(new Date(now).toISOString())}`,
        `*Detail*: ${escapeMrkdwn(detail)}`,
        `*Next Notification After*: ${escapeMrkdwn(new Date(now + config.authAlertIntervalMs).toISOString())}`,
      ].join("\n"))],
    });
    log("warn", `Auth failure notification sent: ${detail}`);
  } catch (notifyError) {
    log("error", `Failed to send auth failure notification: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
  }
}

function clearAuthFailureNotice() {
  const authState = state.meta.auth.refreshFailure;
  if (!authState.lastNotifiedAt && !authState.lastError) return;
  authState.lastNotifiedAt = 0;
  authState.lastError = "";
  saveState(stateFile, state);
}
function parseBroadcasterLogins(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function loadState(filePath, broadcasters) {
  if (!fs.existsSync(filePath)) return { broadcasters: seedBroadcasters(broadcasters), meta: seedStateMeta() };

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  parsed.broadcasters ||= {};
  parsed.meta ||= seedStateMeta();
  parsed.meta.auth ||= seedStateMeta().auth;
  parsed.meta.auth.refreshFailure ||= seedStateMeta().auth.refreshFailure;
  for (const broadcaster of broadcasters) {
    parsed.broadcasters[broadcaster.id] ||= seedBroadcaster(broadcaster);
  }
  return parsed;
}

function seedStateMeta() {
  return {
    auth: {
      refreshFailure: {
        lastNotifiedAt: 0,
        lastError: "",
      },
    },
  };
}
function seedBroadcasters(broadcasters) {
  const items = {};
  for (const broadcaster of broadcasters) items[broadcaster.id] = seedBroadcaster(broadcaster);
  return items;
}

function seedBroadcaster(broadcaster) {
  return {
    id: broadcaster.id,
    login: broadcaster.login,
    displayName: broadcaster.displayName || broadcaster.login,
    title: "",
    categoryId: "",
    categoryName: "",
    language: "",
    live: false,
    initialUpdateNotified: false,
    startedAt: null,
  };
}

function saveState(filePath, currentState) {
  ensureStateDirectory(filePath);
  fs.writeFileSync(filePath, JSON.stringify(currentState, null, 2));
}

function ensureStateDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function twitchHeaders() {
  return {
    "Client-Id": config.twitchClientId,
    Authorization: `Bearer ${config.twitchAccessToken}`,
    "Content-Type": "application/json",
  };
}

function resetKeepaliveTimeout(keepaliveTimeoutSeconds) {
  clearKeepaliveTimer();
  const timeoutMs = Math.max((keepaliveTimeoutSeconds + 20) * 1000, 60000);
  keepaliveTimer = setTimeout(() => {
    log("warn", "Keepalive timeout reached; closing socket");
    if (websocket) websocket.close();
  }, timeoutMs);
}

function clearKeepaliveTimer() {
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(EVENTSUB_WS_URL).catch((error) => {
      log("error", error instanceof Error ? error.stack || error.message : String(error));
      scheduleReconnect();
    });
  }, config.reconnectDelayMs);
}

function displayNameOf(broadcaster) {
  return broadcaster.displayName || broadcaster.login || broadcaster.id;
}

function streamUrl(login) {
  return `https://www.twitch.tv/${login}`;
}

function sectionBlock(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function headline(text) {
  return `[Hajimatta] ${text}`;
}

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}






