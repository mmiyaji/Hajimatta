
const WebSocket = require("ws");
const fs = require("node:fs");
const path = require("node:path");
const { chatSettingsChanges, normalizeApiChatSettings } = require("./chat-settings");
const { acquireInstanceGuard } = require("./instance-guard");
const { listSubscriptions, summarizeSubscriptions } = require("./subscription-diagnostics");
const { startDashboard } = require("./terminal-dashboard");
const { SlackOutbox, sendSlackWebhook } = require("./slack-outbox");
const { HealthAlerts } = require("./health-alerts");
const { FileLogger, redactLog } = require("./file-logger");
const { readAutoCommentConfig, commentOnRelease, commentOnStart } = require("./auto-comment");
const diagnosticOnly = process.argv.includes("--diagnose");

const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const TWITCH_API_BASE_URL = "https://api.twitch.tv/helix";
const TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const SUBSCRIPTION_TYPES = ["stream.online", "channel.update"];
const CHAT_SETTINGS_TYPE = "channel.chat_settings.update";
const MAX_BROADCASTERS = 5;
const WS_CONNECT_TIMEOUT_MS = 15000;
const WS_SETUP_TIMEOUT_MS = 30000;

const env = loadEnv();
const broadcasterLogins = parseBroadcasterLogins(env.TWITCH_BROADCASTERS);
const autoCommentConfig = readAutoCommentConfig(env, broadcasterLogins.map(login => login.toLowerCase()));
const startCommentConfig = readAutoCommentConfig(env, broadcasterLogins.map(login => login.toLowerCase()), "TWITCH_STREAM_START_COMMENT");
const stateFile = path.resolve(process.cwd(), env.STATE_FILE || "./data/state.json");

if (!env.TWITCH_CLIENT_ID) throw new Error("TWITCH_CLIENT_ID is required.");
if (!env.TWITCH_ACCESS_TOKEN) throw new Error("TWITCH_ACCESS_TOKEN is required.");
if (!diagnosticOnly && !env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL is required.");
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
  slackMessageMode: env.SLACK_MESSAGE_MODE || "aligned",
  liveReconcileLogMode: env.LIVE_RECONCILE_LOG_MODE || "changes",
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
let liveReconcileTimer = null;
let eventsubReady = false;
let chatUserId = null;
let instanceGuard = null;
let diagnosticInFlight = null;
let diagnosticReport = null;
let diagnosticReportAt = null;
let dashboard = null;
let slackOutbox = null;
let healthAlerts = null;
let healthTimer = null;
let diagnosticTimer = null;
let chatReconcileTimer = null;
let chatReconcileInFlight = false;
let fileLogger = null;
let chatSenderId = null;
let chatCanWrite = false;
const chatApiBaselines = new Set();
const freshness = { startedAt: Date.now() };

main().catch(async (error) => {
  clearInterval(healthTimer);
  clearInterval(diagnosticTimer);
  clearInterval(chatReconcileTimer);
  if (healthAlerts) {
    try {
      healthAlerts.set("Process startup", "起動処理に失敗しました。稼働環境のログを確認してください。", true);
      await slackOutbox.flush();
    } catch { log("error", "Failed to persist startup failure alert"); }
    await slackOutbox.close().catch(() => {});
  }
  log("fatal", error instanceof Error ? error.stack || error.message : String(error));
  if (dashboard) {
    dashboard.close();
    console.error(redactLog(error instanceof Error ? error.message : String(error), logSecrets()));
  }
  process.exitCode = 1;
  if (instanceGuard) instanceGuard.close().catch(() => {});
});

async function main() {
  if (!diagnosticOnly && process.argv.includes("--dashboard")) {
    dashboard = startDashboard(() => ({
      connection: !websocket ? "disconnected / reconnecting" : websocket.readyState === WebSocket.OPEN
        ? websocket.subscriptionsReady ? "connected" : "registering" : "connecting",
      report: diagnosticReport, reportAt: diagnosticReportAt,
      slack: slackOutbox?.status(),
      freshness: { ...freshness, wsLimitMs: Math.max((keepaliveTimeoutSeconds + 20) * 1000, 60000), streamLimitMs: config.liveReconcileIntervalMs * 2 + 10000 },
      logFailed: fileLogger?.failed || false,
      broadcasters: resolvedBroadcasters.map(broadcaster => {
        const current = state.broadcasters[broadcaster.id];
        return { ...broadcaster, live: current?.live || false, title: current?.title || "", categoryName: current?.categoryName || "",
          startedAt: current?.startedAt, lastOfflineAt: current?.lastOfflineAt,
          emoteMode: current?.chatSettings?.emote_mode };
      }),
    }), { refresh: () => diagnoseSubscriptions(websocket?.eventsubSessionId || null), logLevel: env.DASHBOARD_LOG_LEVEL || "warn" });
    if (!dashboard) log("warn", "Dashboard requires an interactive terminal; using standard logs");
  }
  if (!diagnosticOnly) {
    instanceGuard = await acquireInstanceGuard(config.twitchClientId, env.TWITCH_INSTANCE_PORT);
    fileLogger = new FileLogger(env.LOG_DIR || path.join(path.dirname(stateFile), "logs"), {
      onError: message => { if (dashboard) dashboard.log("error", message); else console.error(message); },
    });
    log("info", `Instance guard acquired: 127.0.0.1:${instanceGuard.port}`);
  }
  if (!diagnosticOnly) ensureStateDirectory(stateFile);
  if (!diagnosticOnly) {
    slackOutbox = new SlackOutbox(path.resolve(env.SLACK_OUTBOX_FILE || path.join(path.dirname(stateFile), "slack-outbox.json")), {
      send: payload => sendSlackWebhook(config.slackWebhookUrl, payload), log,
    });
    healthAlerts = new HealthAlerts(slackOutbox, {
      repeatMs: Number.isFinite(config.authAlertIntervalMs) ? Math.max(60000, config.authAlertIntervalMs) : 7200000,
    });
    slackOutbox.start();
    healthTimer = setInterval(checkHealth, 15000);
  }
  const initialState = diagnosticOnly ? state : loadState(stateFile, []);
  state.broadcasters = initialState.broadcasters;
  state.meta = initialState.meta;
  await ensureValidUserAccessToken();
  resolvedBroadcasters = await resolveBroadcasters(broadcasterLogins);
  if (resolvedBroadcasters.length === 0) {
    throw new Error("No broadcasters could be resolved from TWITCH_BROADCASTERS.");
  }

  const hydratedState = diagnosticOnly ? state : loadState(stateFile, resolvedBroadcasters);
  state.broadcasters = hydratedState.broadcasters;
  state.meta = hydratedState.meta;
  log("info", `Resolved ${resolvedBroadcasters.length} broadcasters`);
  if (diagnosticOnly) {
    await diagnoseSubscriptions();
    return;
  }
  await diagnoseSubscriptions().catch(error => log("warn", error.message));
  await hydrateInitialState();
  await cleanupManagedSubscriptions();
  await connect(EVENTSUB_WS_URL);
  startLiveReconcileLoop();
  void reconcileChatSettings().catch(error => log("warn", error.message));
  chatReconcileTimer = setInterval(() => {
    reconcileChatSettings().catch(error => log("warn", error.message));
  }, 30000);
  healthAlerts.set("Process startup", null);
  diagnosticTimer = setInterval(() => {
    diagnoseSubscriptions(websocket?.eventsubSessionId || null).catch(() => {
      try { healthAlerts?.set("Subscription diagnostics", "購読状況の取得に失敗しています。--diagnoseで確認してください。"); }
      catch { log("error", "Failed to persist subscription diagnostic alert"); }
    });
  }, 60000);
}

function checkHealth() {
  if (!healthAlerts) return;
  try {
    const connected = websocket?.readyState === WebSocket.OPEN && websocket.subscriptionsReady;
    healthAlerts.set("Twitch WebSocket", connected ? null : "EventSub接続が利用できません。APIの定期補完は継続します。");
    if (connected && diagnosticReport?.currentSessionId === websocket.eventsubSessionId) {
      const missing = diagnosticReport.coverage.filter(row => row.status !== "enabled");
      healthAlerts.set("Twitch subscriptions", missing.length ? `未購読または別接続: ${missing.map(row => `${row.login}/${row.type}`).join(", ")}` : null);
    }
    const status = slackOutbox.status();
    healthAlerts.set("Slack delivery", status.retrying || status.stopped ? `Slack送信に失敗しています。送信待ち: ${status.pending}件。Webhook設定とネットワークを確認してください。` : null);
    healthAlerts.tick();
  } catch { log("error", "Health alert persistence failed; check available disk space and outbox permissions"); }
}

async function connect(url, previousSocket = null) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  log("info", `Connecting to Twitch EventSub${previousSocket ? " (session transfer)" : ""}`);
  clearKeepaliveTimer();
  const socket = new WebSocket(url, { handshakeTimeout: WS_CONNECT_TIMEOUT_MS });
  websocket = socket;
  let welcomed = false;
  const failConnection = (reason) => {
    if (socket !== websocket) return;
    log("warn", reason);
    clearTimeout(setupTimer);
    clearTimeout(socket.subscriptionRetryTimer);
    clearKeepaliveTimer();
    websocket = null;
    socket.terminate();
    if (previousSocket) previousSocket.terminate();
    scheduleReconnect();
  };
  const setupTimer = setTimeout(() => {
    failConnection("WebSocket setup timed out; retrying connection");
  }, WS_SETUP_TIMEOUT_MS);

  socket.on("open", () => {
    if (socket !== websocket) return;
    log("info", "WebSocket connected");
  });

  socket.on("message", async (data) => {
    if (socket !== websocket && websocket?.previousSocket !== socket) return;

    try {
      const payload = JSON.parse(String(data));
      if (socket === websocket) freshness.wsReceivedAt = Date.now();
      if (socket !== websocket) {
        if (payload.metadata?.message_type === "notification") await handleMessage(payload, socket);
        return;
      }
      if (payload.metadata?.message_type === "session_welcome") {
        if (welcomed) return;
        welcomed = true;
        socket.eventsubSessionId = payload.payload.session.id;
        if (previousSocket) {
          socket.previousSocket = null;
          previousSocket.close();
        }
        await handleMessage(payload, socket, Boolean(previousSocket));
        if (socket !== websocket) return;
        clearTimeout(setupTimer);
        log("info", "EventSub session setup completed (see subscription status above)");
      } else {
        await handleMessage(payload, socket);
      }
    } catch (error) {
      log("error", error instanceof Error ? error.stack || error.message : String(error));
      if (!welcomed || !socket.subscriptionsReady) failConnection("EventSub setup failed; retrying connection");
    }
  });

  socket.previousSocket = previousSocket;
  socket.on("close", (code, reason) => {
    clearTimeout(setupTimer);
    clearTimeout(socket.subscriptionRetryTimer);
    if (socket !== websocket) return;
    log("warn", `WebSocket closed: code=${code} reason=${String(reason) || "(none)"}`);
    clearKeepaliveTimer();
    websocket = null;
    if (previousSocket) previousSocket.terminate();
    scheduleReconnect();
  });

  socket.on("error", (error) => {
    if (socket !== websocket) return;
    log("error", error?.message || "WebSocket error");
    failConnection("WebSocket error; retrying connection");
  });
}

async function handleMessage(payload, socket = websocket, transferred = false) {
  const metadata = payload.metadata || {};
  const messageType = metadata.message_type;
  const messageId = metadata.message_id;
  const keepaliveSeconds = payload.payload?.session?.keepalive_timeout_seconds;

  if (socket === websocket && keepaliveSeconds) {
    keepaliveTimeoutSeconds = keepaliveSeconds;
    resetKeepaliveTimeout(keepaliveTimeoutSeconds);
  }
  if (socket === websocket && (messageType === "notification" || messageType === "session_keepalive")) {
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
      resetKeepaliveTimeout(keepaliveTimeoutSeconds);
      if (!transferred) await registerSubscriptions(payload.payload.session.id, socket);
      if (socket === websocket) socket.subscriptionsReady = true;
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
      healthAlerts?.set("Twitch subscriptions", "EventSub購読が失効しました。--diagnoseで確認してください。", true);
      return;
    default:
      log("info", `Unhandled message type: ${messageType || "unknown"}`);
  }
}

async function registerSubscriptions(sessionId, socket = websocket) {
  const total = resolvedBroadcasters.length * (SUBSCRIPTION_TYPES.length + (chatUserId ? 1 : 0));
  log("info", `Registering ${total} subscriptions on session ${sessionId}`);
  socket.registeredSubscriptions ||= new Set();
  let retryDelayMs = 0;
  // Register zero-cost chat events first so a full cost budget cannot prevent them.
  const types = [...(chatUserId ? [CHAT_SETTINGS_TYPE] : []), ...SUBSCRIPTION_TYPES];
  for (const type of types) {
    for (const broadcaster of resolvedBroadcasters) {
      if (socket !== websocket) return;
      const key = `${type}:${broadcaster.id}`;
      if (socket.registeredSubscriptions.has(key)) continue;
      try {
        await createSubscription(type, broadcaster.id, sessionId);
        socket.registeredSubscriptions.add(key);
      } catch (error) {
        if (error.status !== 429) throw error;
        retryDelayMs = Math.max(retryDelayMs, error.retryDelayMs || 60000);
        log("warn", `Subscription deferred: ${key}; keeping active subscriptions. ${error.message}`);
      }
    }
  }
  if (socket !== websocket) return;
  eventsubReady = true;
  void diagnoseSubscriptions(sessionId).catch(error => log("warn", error.message));
  if (retryDelayMs) {
    log("warn", `EventSub partially ready: ${socket.registeredSubscriptions.size}/${total}; retry in ${Math.ceil(retryDelayMs / 1000)}s. Check for another running instance or subscriptions sharing this Twitch application/user.`);
    clearTimeout(socket.subscriptionRetryTimer);
    socket.subscriptionRetryTimer = setTimeout(() => {
      if (socket !== websocket) return;
      registerSubscriptions(sessionId, socket).catch(error => {
        log("error", error.stack || error.message);
        if (socket === websocket) socket.terminate();
      });
    }, retryDelayMs);
  }
}

async function cleanupManagedSubscriptions() {
  const { data: subscriptions } = await listSubscriptions(subscriptionListRequest);
  const managedTypes = new Set([...SUBSCRIPTION_TYPES, CHAT_SETTINGS_TYPE]);
  const managedBroadcasterIds = new Set(resolvedBroadcasters.map((b) => b.id));

  for (const subscription of subscriptions) {
    if (subscription.transport?.method !== "websocket") continue;
    if (!managedTypes.has(subscription.type)) continue;
    if (!managedBroadcasterIds.has(subscription.condition?.broadcaster_user_id)) continue;
    if (subscription.status === "enabled") {
      log("warn", `Preserving active subscription on another session: ${subscription.type}:${subscription.condition?.broadcaster_user_id} session=${subscription.transport?.session_id}`);
      continue;
    }

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

function subscriptionListRequest(url) {
  return twitchFetch(url, { headers: twitchHeaders(), signal: AbortSignal.timeout(10000) }, { retryOnUnauthorized: !diagnosticOnly });
}

async function diagnoseSubscriptions(sessionId = null) {
  if (diagnosticInFlight) return diagnosticInFlight;
  diagnosticInFlight = (async () => {
    const snapshot = await listSubscriptions(subscriptionListRequest);
    const types = [...SUBSCRIPTION_TYPES, ...(chatUserId ? [CHAT_SETTINGS_TYPE] : [])];
    const report = summarizeSubscriptions(snapshot, resolvedBroadcasters, types, sessionId, chatUserId);
    diagnosticReport = report;
    diagnosticReportAt = new Date().toLocaleTimeString();
    freshness.diagnosticsAt = Date.now();
    healthAlerts?.set("Subscription diagnostics", null);
    log("info", `EventSub diagnostics: cost=${report.totalCost ?? "unknown"}/${report.maxTotalCost ?? "unknown"} total=${report.total ?? "unknown"} enabledWebSockets=${report.enabledWebSockets} (API totals may lag)`);
    for (const row of report.subscriptions) log("info", `EventSub subscription: ${JSON.stringify(row)}`);
    for (const row of report.coverage) log(row.status === "enabled" ? "info" : "warn", `EventSub coverage: ${JSON.stringify(row)}`);
    if (!chatUserId) log("warn", "EventSub diagnostics: chat settings not requested; user:read:chat scope is missing");
    return report;
  })();
  try { return await diagnosticInFlight; } finally { diagnosticInFlight = null; }
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
        condition: {
          broadcaster_user_id: broadcasterUserId,
          ...(type === CHAT_SETTINGS_TYPE ? { user_id: chatUserId } : {}),
        },
        transport: { method: "websocket", session_id: sessionId },
      }),
    },
    { retryOnUnauthorized: true }
  );

  if (response.status === 409) {
    const snapshot = await listSubscriptions(subscriptionListRequest);
    const owned = snapshot.data.some(subscription => subscription.type === type && subscription.version === "1"
      && subscription.condition?.broadcaster_user_id === broadcasterUserId
      && (type !== CHAT_SETTINGS_TYPE || subscription.condition?.user_id === chatUserId)
      && subscription.status === "enabled" && subscription.transport?.method === "websocket"
      && subscription.transport.session_id === sessionId);
    if (owned) return;
    const error = new Error(`Subscription conflict on another session: ${type}:${broadcasterUserId}; inspect --diagnose and stop the other instance`);
    error.status = 429;
    error.retryDelayMs = 60000;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Failed to create subscription ${type}:${broadcasterUserId}: ${response.status} ${text}`);
    error.status = response.status;
    const resetSeconds = Number(response.headers?.get("Ratelimit-Reset"));
    error.retryDelayMs = Math.max(60000, Number.isFinite(resetSeconds) ? resetSeconds * 1000 - Date.now() + 1000 : 0);
    throw error;
  }

  log("info", `Subscribed: ${type}:${broadcasterUserId}`);
}

async function reconnectTo(url) {
  log("info", "Reconnect requested by Twitch");
  clearKeepaliveTimer();
  const previousSocket = websocket;
  await connect(url, previousSocket);
}
async function ensureValidUserAccessToken() {
  let validation = await validateUserAccessToken();
  if (!validation.ok) {
    if (diagnosticOnly) throw new Error(`Diagnostic token validation failed; renew the token using normal startup. ${validation.detail}`);
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

  if (!diagnosticOnly) clearAuthFailureNotice();
  healthAlerts?.set("Twitch authentication", null);
  chatUserId = validation.data.scopes?.includes("user:read:chat") ? validation.data.user_id : null;
  chatSenderId = validation.data.user_id;
  chatCanWrite = Boolean(validation.data.scopes?.includes("user:write:chat"));
  if ((autoCommentConfig.enabled || startCommentConfig.enabled) && !chatCanWrite) log("warn", "Auto-comment disabled: authorize user:write:chat scope; monitoring continues");
  if (!chatUserId) log("warn", "Chat mode realtime events disabled: reauthorize with user:read:chat; API polling remains active");
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
    healthAlerts?.set("Twitch authentication", null);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function twitchFetch(url, options, settings = {}) {
  let response = await fetch(url, options);
  if (response.status === 401 && settings.retryOnUnauthorized && !diagnosticOnly) {
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
      resolved.push({
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        profileImageUrl: user.profile_image_url || "",
      });
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
  freshness.streamCheckedAt = Date.now();
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
    // A transition missed while stopped has no reliable end timestamp.
    const nextLastOfflineAt = nextLive || current.live ? null : current.lastOfflineAt ?? null;

    if (
      current.title !== nextTitle ||
      current.categoryId !== nextCategoryId ||
      current.categoryName !== nextCategoryName ||
      current.language !== nextLanguage ||
      current.live !== nextLive ||
      current.startedAt !== nextStartedAt ||
      current.lastOfflineAt !== nextLastOfflineAt ||
      current.initialUpdateNotified !== nextInitialUpdateNotified
    ) {
      current.title = nextTitle;
      current.categoryId = nextCategoryId;
      current.categoryName = nextCategoryName;
      current.language = nextLanguage;
      current.live = nextLive;
      current.startedAt = nextStartedAt;
      current.lastOfflineAt = nextLastOfflineAt;
      current.initialUpdateNotified = nextInitialUpdateNotified;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
    }

    if (nextLive) {
      current.startCommentStreamKey = liveStream.id || nextStartedAt;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
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
  if (config.liveReconcileLogMode !== "silent") {
    log("info", `Starting live reconcile loop: intervalMs=${config.liveReconcileIntervalMs} intervalSec=${Math.round(config.liveReconcileIntervalMs / 1000)} mode=${config.liveReconcileLogMode}`);
  }
  liveReconcileTimer = setInterval(() => {
    reconcileLiveState().catch((error) => {
      log("error", error instanceof Error ? error.stack || error.message : String(error));
    });
  }, config.liveReconcileIntervalMs);
}

async function reconcileLiveState() {
  if (config.liveReconcileLogMode === "verbose") {
    log("info", `Running live reconcile check for ${resolvedBroadcasters.length} broadcasters`);
  }
  let streams;
  try {
    streams = await fetchLiveStreamsByLogin(resolvedBroadcasters.map((b) => b.login));
    freshness.streamCheckedAt = Date.now();
    healthAlerts?.set("Twitch API", null);
  } catch (error) {
    healthAlerts?.set("Twitch API", "配信状態のAPI補完に失敗しています。ネットワークと認証設定を確認してください。");
    throw error;
  }
  const streamsByLogin = new Map(streams.map((stream) => [stream.user_login, stream]));
  let changed = false;
  let reconciledOnline = 0;
  let reconciledOffline = 0;

  for (const broadcaster of resolvedBroadcasters) {
    const current = state.broadcasters[broadcaster.id] || seedBroadcaster(broadcaster);
    const liveStream = streamsByLogin.get(broadcaster.login);

    if (liveStream && !current.live) {
      current.live = true;
      current.lastOfflineAt = null;
      current.startedAt = liveStream.started_at || null;
      current.initialUpdateNotified = false;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
      reconciledOnline += 1;
      {
        await postToSlack({
          ...buildSlackPayload({
            headlineText: `${displayNameOf(current)} started streaming`,
            iconUrl: current.profileImageUrl,
            plainLines: [
              `${displayNameOf(current)} が配信を開始しました。`,
              current.startedAt ? `開始時刻: ${current.startedAt}` : null,
              `URL: ${streamUrl(current.login)}`,
            ],
            blockLines: [
              `*${displayNameOf(current)}* が配信を開始しました。`,
              current.startedAt ? `*開始時刻*: ${escapeMrkdwn(current.startedAt)}` : null,
              `*URL*: ${streamUrl(current.login)}`,
            ],
          }),
        });
      }
      log("info", `Live state reconciled online: login=${broadcaster.login} startedAt=${current.startedAt || "(unknown)"} url=${streamUrl(broadcaster.login)}`);
      await handleStartComment(current, liveStream.id || current.startedAt);
      continue;
    }

    if (!liveStream && current.live) {
      await postToSlack(buildSlackPayload({
        headlineText: `${displayNameOf(current)} stream ended (confirmed)`,
        iconUrl: current.profileImageUrl,
        plainLines: [
          `${displayNameOf(current)} stream end confirmed by API reconcile.`,
          current.title ? `Title: ${current.title}` : null,
          current.categoryName ? `Category: ${current.categoryName}` : null,
          current.startedAt ? `Started At: ${current.startedAt}` : null,
          `URL: ${streamUrl(current.login)}`,
        ],
        blockLines: [
          `*${displayNameOf(current)}* stream end confirmed by API reconcile.`,
          current.title ? `*Title*: ${escapeMrkdwn(current.title)}` : null,
          current.categoryName ? `*Category*: ${escapeMrkdwn(current.categoryName)}` : null,
          current.startedAt ? `*Started At*: ${escapeMrkdwn(current.startedAt)}` : null,
          `*URL*: ${streamUrl(current.login)}`,
        ],
      }));

      current.live = false;
      current.lastOfflineAt = new Date().toISOString();
      current.startedAt = null;
      current.initialUpdateNotified = false;
      state.broadcasters[broadcaster.id] = current;
      changed = true;
      reconciledOffline += 1;
      log("info", `Live state reconciled offline: login=${broadcaster.login} url=${streamUrl(broadcaster.login)}`);
    }
  }

  if (changed) saveState(stateFile, state);
  if (config.liveReconcileLogMode === "verbose" || (config.liveReconcileLogMode === "changes" && changed)) {
    log("info", `Live reconcile completed: currentLive=${streams.length} reconciledOnline=${reconciledOnline} reconciledOffline=${reconciledOffline} changed=${changed}`);
  }
}
async function handleNotification(subscription, event) {
  switch (subscription.type) {
    case "stream.online":
      await handleStreamOnline(event);
      return;
    case "channel.update":
      await handleChannelUpdate(event);
      return;
    case CHAT_SETTINGS_TYPE:
      await handleChatSettingsUpdate(event);
      return;
    default:
      log("info", `Ignored event: ${subscription.type}`);
  }
}

async function reconcileChatSettings() {
  if (chatReconcileInFlight) return;
  chatReconcileInFlight = true;
  let failed = false;
  try {
    for (const broadcaster of resolvedBroadcasters) {
      const expectedSettings = state.broadcasters[broadcaster.id]?.chatSettings;
      try {
        const response = await twitchFetch(`${TWITCH_API_BASE_URL}/chat/settings?broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
          { headers: twitchHeaders(), signal: AbortSignal.timeout(10000) }, { retryOnUnauthorized: true });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        const event = normalizeApiChatSettings(json.data?.[0], broadcaster);
        // A live event received during the request is newer than this API snapshot.
        if (state.broadcasters[broadcaster.id]?.chatSettings !== expectedSettings) continue;
        await handleChatSettingsUpdate(event, "api");
      } catch (error) {
        failed = true;
        log("warn", `Chat settings API check failed: login=${broadcaster.login} ${error.message}`);
      }
    }
    if (!failed) freshness.chatCheckedAt = Date.now();
    healthAlerts?.set("Chat settings API", failed ? "チャット設定のAPI補完に失敗しています。ログを確認してください。" : null);
  } finally { chatReconcileInFlight = false; }
}

async function handleChatSettingsUpdate(event, source = "eventsub") {
  const broadcaster = ensureBroadcasterState(event);
  const initialApiCheck = source === "api" && !chatApiBaselines.has(broadcaster.id);
  const previous = broadcaster.chatSettings;
  // First API sample establishes a baseline. An already-active emote mode is still reported.
  const changes = source === "api" && !previous
    ? event.emote_mode ? ["スタンプ限定モード: 現在有効（API初回確認）"] : []
    : chatSettingsChanges(previous, event);
  if (changes.length) {
    postToSlack(buildSlackPayload({
      headlineText: `${displayNameOf(broadcaster)} chat mode updated`,
      iconUrl: broadcaster.profileImageUrl,
      plainLines: [`${displayNameOf(broadcaster)} のチャット設定が更新されました。`, ...changes, `検知経路: ${source === "api" ? "API補完" : "EventSub"}`, `URL: ${streamUrl(broadcaster.login)}`],
      blockLines: [`*${escapeMrkdwn(displayNameOf(broadcaster))}* のチャット設定が更新されました。`, ...changes.map(escapeMrkdwn), `*検知経路*: ${source === "api" ? "API補完" : "EventSub"}`, `*URL*: ${streamUrl(broadcaster.login)}`],
    }));
    log("info", `Chat mode notification queued: source=${source} login=${broadcaster.login} ${changes.join("; ")}`);
  }
  if (source === "eventsub" || !previous) log("info", `Chat settings received: source=${source} login=${broadcaster.login} emote_mode=${event.emote_mode}`);
  broadcaster.chatSettings = { ...event };
  saveState(stateFile, state);
  if (source === "api") chatApiBaselines.add(broadcaster.id);
  if (initialApiCheck) return;
  try {
    const result = await commentOnRelease({ config: autoCommentConfig, previous, current: broadcaster, ...autoCommentTransport(broadcaster) });
    if (result !== "not-triggered") log("info", `Auto-comment: login=${broadcaster.login} result=${result}`);
  } catch (error) {
    log("error", `Auto-comment failed: login=${broadcaster.login} ${error.message}`);
  }
}

function autoCommentTransport(broadcaster, streamKey = null) {
  return { senderId: chatSenderId, canWrite: chatCanWrite, save: () => saveState(stateFile, state),
      isLive: async () => {
        const response = await twitchFetch(`${TWITCH_API_BASE_URL}/streams?user_id=${encodeURIComponent(broadcaster.id)}`,
          { headers: twitchHeaders(), signal: AbortSignal.timeout(10000) }, { retryOnUnauthorized: true });
        if (!response.ok) throw new Error(`Auto-comment live check failed: HTTP ${response.status}`);
        return (await response.json()).data?.some(stream => stream.user_id === broadcaster.id
          && (!streamKey || stream.id === streamKey || stream.started_at === streamKey)) || false;
      },
      isShared: async () => {
        const response = await twitchFetch(`${TWITCH_API_BASE_URL}/shared_chat/session?broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
          { headers: twitchHeaders(), signal: AbortSignal.timeout(10000) }, { retryOnUnauthorized: true });
        if (!response.ok) throw new Error(`Auto-comment Shared Chat check failed: HTTP ${response.status}`);
        const json = await response.json();
        if (!Array.isArray(json.data)) throw new Error("Invalid Shared Chat response");
        return json.data.length > 0;
      },
      send: body => twitchFetch(`${TWITCH_API_BASE_URL}/chat/messages`, {
        method: "POST", headers: twitchHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      }, { retryOnUnauthorized: false }),
  };
}

async function handleStartComment(broadcaster, streamKey) {
  if (!startCommentConfig.enabled) return;
  try {
    const result = await commentOnStart({ config: startCommentConfig, current: broadcaster, streamKey, ...autoCommentTransport(broadcaster, streamKey) });
    if (result !== "not-triggered") log("info", `Start auto-comment: login=${broadcaster.login} result=${result}`);
  } catch (error) { log("error", `Start auto-comment failed: login=${broadcaster.login} ${error.message}`); }
}

async function handleStreamOnline(event) {
  const broadcaster = ensureBroadcasterState(event);
  broadcaster.live = true;
  broadcaster.lastOfflineAt = null;
  broadcaster.startedAt = event.started_at || null;
  broadcaster.initialUpdateNotified = false;
  saveState(stateFile, state);

  await postToSlack({
    ...buildSlackPayload({
      headlineText: `${displayNameOf(broadcaster)} started streaming`,
      iconUrl: broadcaster.profileImageUrl,
      plainLines: [
        `${displayNameOf(broadcaster)} が配信を開始しました。`,
        broadcaster.startedAt ? `開始時刻: ${broadcaster.startedAt}` : null,
        `URL: ${streamUrl(broadcaster.login)}`,
      ],
      blockLines: [
        `*${displayNameOf(broadcaster)}* が配信を開始しました。`,
        broadcaster.startedAt ? `*開始時刻*: ${escapeMrkdwn(broadcaster.startedAt)}` : null,
        `*URL*: ${streamUrl(broadcaster.login)}`,
      ],
    }),
  });

  log("info", `Stream online detected: login=${broadcaster.login} title=${broadcaster.title || "(unknown)"} category=${broadcaster.categoryName || "(unknown)"} url=${streamUrl(broadcaster.login)}`);
  await handleStartComment(broadcaster, event.id || broadcaster.startedAt);
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

    await postToSlack(buildSlackPayload({
      headlineText: `${displayNameOf(broadcaster)} stream prep detected`,
      iconUrl: broadcaster.profileImageUrl,
      plainLines: [
        `${displayNameOf(broadcaster)} が配信準備を始めた可能性があります。`,
        titleChangedWhileOffline ? `タイトル: ${broadcaster.title || "(empty)"} <- ${previousTitle || "(empty)"}` : null,
        categoryChangedWhileOffline ? `カテゴリー: ${broadcaster.categoryName || "(empty)"} <- ${previousCategory || "(empty)"}` : null,
        `URL: ${streamUrl(broadcaster.login)}`,
      ],
      blockLines: [
        `*${displayNameOf(broadcaster)}* が配信準備を始めた可能性があります。`,
        titleChangedWhileOffline ? `*タイトル*: ${escapeMrkdwn(broadcaster.title || "(empty)")} <- ${escapeMrkdwn(previousTitle || "(empty)")}` : null,
        categoryChangedWhileOffline ? `*カテゴリー*: ${escapeMrkdwn(broadcaster.categoryName || "(empty)")} <- ${escapeMrkdwn(previousCategory || "(empty)")}` : null,
        `*URL*: ${streamUrl(broadcaster.login)}`,
      ],
    }));

    log("info", `Pre-stream update detected: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
    return;
  }

  if (!broadcaster.initialUpdateNotified) {
    broadcaster.initialUpdateNotified = true;
    saveState(stateFile, state);

    await postToSlack(buildSlackPayload({
      headlineText: `${displayNameOf(broadcaster)} stream details updated`,
      iconUrl: broadcaster.profileImageUrl,
      plainLines: [
        `${displayNameOf(broadcaster)} の配信情報を受信しました。`,
        broadcaster.title ? `タイトル: ${broadcaster.title}` : null,
        broadcaster.categoryName ? `カテゴリー: ${broadcaster.categoryName}` : null,
        `URL: ${streamUrl(broadcaster.login)}`,
      ],
      blockLines: [
        `*${displayNameOf(broadcaster)}* の配信情報を受信しました。`,
        broadcaster.title ? `*タイトル*: ${escapeMrkdwn(broadcaster.title)}` : null,
        broadcaster.categoryName ? `*カテゴリー*: ${escapeMrkdwn(broadcaster.categoryName)}` : null,
        `*URL*: ${streamUrl(broadcaster.login)}`,
      ],
    }));

    log("info", `Initial channel update notified: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
    return;
  }

  const titleChanged = previousTitle !== broadcaster.title;
  const categoryChanged = previousCategory !== broadcaster.categoryName;
  if (!titleChanged && !categoryChanged) return;

  await postToSlack(buildSlackPayload({
    headlineText: `${displayNameOf(broadcaster)} updated stream settings`,
    iconUrl: broadcaster.profileImageUrl,
    plainLines: [
      `${displayNameOf(broadcaster)} の配信情報が更新されました。`,
      titleChanged ? `タイトル: ${broadcaster.title || "(empty)"} <- ${previousTitle || "(empty)"}` : null,
      categoryChanged ? `カテゴリー: ${broadcaster.categoryName || "(empty)"} <- ${previousCategory || "(empty)"}` : null,
      `URL: ${streamUrl(broadcaster.login)}`,
    ],
    blockLines: [
      `*${displayNameOf(broadcaster)}* の配信情報が更新されました。`,
      titleChanged ? `*タイトル*: ${escapeMrkdwn(broadcaster.title || "(empty)")} <- ${escapeMrkdwn(previousTitle || "(empty)")}` : null,
      categoryChanged ? `*カテゴリー*: ${escapeMrkdwn(broadcaster.categoryName || "(empty)")} <- ${escapeMrkdwn(previousCategory || "(empty)")}` : null,
      `*URL*: ${streamUrl(broadcaster.login)}`,
    ],
  }));

  log("info", `Channel update notified: login=${broadcaster.login} title=${broadcaster.title || "(empty)"} category=${broadcaster.categoryName || "(empty)"} url=${streamUrl(broadcaster.login)}`);
}
function postToSlack(payload) {
  if (!slackOutbox) throw new Error("Slack outbox is not initialized");
  slackOutbox.enqueue(payload);
}

function buildSlackPayload({ headlineText, plainLines, blockLines, iconUrl }) {
  const normalizedPlainLines = plainLines.filter(Boolean);
  const normalizedBlockLines = blockLines.filter(Boolean);
  const alignedText = [headline(headlineText), ...normalizedPlainLines].join("\n");
  const legacyText = headline(headlineText);
  const section = sectionBlock(normalizedBlockLines.join("\n"), iconUrl);

  return {
    text: config.slackMessageMode === "legacy" ? legacyText : alignedText,
    blocks: [section],
  };
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
  broadcaster.profileImageUrl = broadcaster.profileImageUrl ?? "";
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

async function notifyAuthFailure() {
  healthAlerts?.set("Twitch authentication", "Twitch token refresh failed. Check the authentication settings and local logs.", true);
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
    profileImageUrl: broadcaster.profileImageUrl || "",
    title: "",
    categoryId: "",
    categoryName: "",
    language: "",
    live: false,
    initialUpdateNotified: false,
    startedAt: null,
    lastOfflineAt: null,
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
    if (websocket) websocket.terminate();
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

function sectionBlock(text, imageUrl) {
  const block = { type: "section", text: { type: "mrkdwn", text } };
  if (imageUrl) {
    block.accessory = {
      type: "image",
      image_url: imageUrl,
      alt_text: "twitch profile image",
    };
  }
  return block;
}

function headline(text) {
  return `[Hajimatta] ${text}`;
}

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function logSecrets() {
  return [config.twitchAccessToken, config.twitchRefreshToken, config.twitchClientSecret, config.slackWebhookUrl,
    env.TWITCH_ACCESS_TOKEN, env.TWITCH_REFRESH_TOKEN, env.TWITCH_CLIENT_SECRET];
}

function log(level, message) {
  message = redactLog(message, logSecrets());
  fileLogger?.write(level, message);
  if (dashboard) { dashboard.log(level, message); return; }
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}






