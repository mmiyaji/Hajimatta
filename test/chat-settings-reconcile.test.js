const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { chatSettingsChanges, normalizeApiChatSettings } = require("../src/chat-settings");

function harness(request) {
  const current = { id: "1", login: "channel", displayName: "Channel" };
  const sent = [], alerts = [];
  const context = vm.createContext({
    state: { broadcasters: { "1": current } }, stateFile: "unused", resolvedBroadcasters: [current],
    TWITCH_API_BASE_URL: "https://api.twitch.tv/helix", AbortSignal,
    chatSettingsChanges, normalizeApiChatSettings, encodeURIComponent,
    twitchFetch: request, twitchHeaders: () => ({}), ensureBroadcasterState: () => current,
    postToSlack: payload => sent.push(payload), buildSlackPayload: payload => payload,
    displayNameOf: b => b.displayName, escapeMrkdwn: text => text, streamUrl: () => "channel-url", saveState() {}, log() {},
    healthAlerts: { set: (...args) => alerts.push(args) },
  });
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  vm.runInContext(`let chatReconcileInFlight = false;
    ${source.slice(source.indexOf("async function reconcileChatSettings("), source.indexOf("async function handleStreamOnline("))}
  `, context);
  return { current, sent, alerts, run: code => vm.runInContext(code, context) };
}

const apiResponse = emote_mode => ({ ok: true, json: async () => ({ data: [{ broadcaster_id: "1", emote_mode,
  follower_mode: false, slow_mode: false, subscriber_mode: false, unique_chat_mode: false,
  follower_mode_duration: null, slow_mode_wait_time: null }] }) });

test("API fallback detects emote start and release without a WS subscription", async () => {
  let enabled = false;
  const h = harness(async () => apiResponse(enabled));
  await h.run("reconcileChatSettings()");
  assert.equal(h.sent.length, 0);
  enabled = true; await h.run("reconcileChatSettings()");
  assert.match(h.sent[0].plainLines.join("\n"), /スタンプ限定モード: 開始/);
  assert.match(h.sent[0].plainLines.join("\n"), /API補完/);
  await h.run("reconcileChatSettings()"); assert.equal(h.sent.length, 1);
  enabled = false; await h.run("reconcileChatSettings()");
  assert.match(h.sent[1].plainLines.join("\n"), /スタンプ限定モード: 解除/);
});

test("first sample reports an already-active emote mode", async () => {
  const h = harness(async () => apiResponse(true));
  await h.run("reconcileChatSettings()");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].plainLines.join("\n"), /現在有効/);
});

test("an API request cannot overwrite a live event received during the request", async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.run("reconcileChatSettings()");
  await h.run('handleChatSettingsUpdate({ emote_mode: true }, "eventsub")');
  finish(apiResponse(false)); await pending;
  assert.equal(h.current.chatSettings.emote_mode, true);
  assert.equal(h.sent.length, 1);
});

test("overlapping checks are suppressed and HTTP failure preserves last-known state", async () => {
  let finish, calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.current.chatSettings = { emote_mode: true };
  const pending = h.run("reconcileChatSettings()");
  await h.run("reconcileChatSettings()"); assert.equal(calls, 1);
  finish({ ok: false, status: 401 }); await pending;
  assert.equal(h.current.chatSettings.emote_mode, true);
  assert.equal(h.sent.length, 0);
  assert.ok(h.alerts.some(([key, detail]) => key === "Chat settings API" && detail));
});

test("polling and WS do not duplicate the same update", async () => {
  const h = harness(async () => apiResponse(false));
  await h.run("reconcileChatSettings()");
  await Promise.all([h.run('handleChatSettingsUpdate({ emote_mode: true }, "eventsub")'), h.run('handleChatSettingsUpdate({ emote_mode: true }, "eventsub")')]);
  assert.equal(h.sent.length, 1);
});

test("API duration field names are normalized to the EventSub schema", () => {
  const normalized = normalizeApiChatSettings({ broadcaster_id: "1", emote_mode: false,
    follower_mode_duration: 15, slow_mode_wait_time: 30 }, { id: "1", login: "channel" });
  assert.equal(normalized.follower_mode_duration_minutes, 15);
  assert.equal(normalized.slow_mode_wait_time_seconds, 30);
  assert.throws(() => normalizeApiChatSettings({ broadcaster_id: "other", emote_mode: false }, { id: "1" }), /Invalid/);
});
