const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readAutoCommentConfig, commentOnRelease, commentOnStart, ReleaseCommentScheduler } = require("../src/auto-comment");

function fixture() {
  const sent = [];
  let saved = false;
  return { sent, config: { enabled: true, channels: ["target"], message: "こんにちは", allowOffline: false, cooldownMs: 300000 },
    previous: { emote_mode: true }, current: { id: "1", login: "target", chatSettings: { emote_mode: false } },
    senderId: "sender", canWrite: true, isLive: async () => true, isShared: async () => false, save: () => { saved = true; }, now: () => 1000000,
    send: async body => { assert.ok(saved); sent.push(body); return { ok: true, json: async () => ({ data: [{ is_sent: true }] }) }; },
  };
}

test("feature defaults off and validates explicit channel/message settings", () => {
  assert.equal(readAutoCommentConfig({}, []).enabled, false);
  const env = { TWITCH_EMOTE_RELEASE_COMMENT_ENABLED: "true", TWITCH_EMOTE_RELEASE_COMMENT_CHANNELS: "target", TWITCH_EMOTE_RELEASE_COMMENT_MESSAGE: "hello" };
  assert.equal(readAutoCommentConfig(env, ["target"]).allowOffline, false);
  assert.throws(() => readAutoCommentConfig(env, ["other"]), /TWITCH_BROADCASTERS/);
  assert.throws(() => readAutoCommentConfig({ ...env, TWITCH_EMOTE_RELEASE_COMMENT_MESSAGE: "x".repeat(501) }, ["target"]), /500/);
});

test("only a configured channel's true-to-false transition posts", async () => {
  const f = fixture();
  assert.equal(await commentOnRelease(f), "sent");
  assert.deepEqual(f.sent, [{ broadcaster_id: "1", sender_id: "sender", message: "こんにちは" }]);
  for (const patch of [{ previous: undefined }, { previous: { emote_mode: false } }, { current: { login: "other", chatSettings: { emote_mode: false } } }, { config: { enabled: false } }]) {
    const next = Object.assign(fixture(), patch);
    assert.equal(await commentOnRelease(next), "not-triggered"); assert.equal(next.sent.length, 0);
  }
});

test("missing write scope, offline policy and persisted cooldown suppress posting", async () => {
  for (const [patch, expected] of [[{ canWrite: false }, "missing-scope"], [{ isLive: async () => false }, "offline"], [{ isShared: async () => true }, "shared-chat"]]) {
    const f = Object.assign(fixture(), patch); assert.equal(await commentOnRelease(f), expected); assert.equal(f.sent.length, 0);
  }
  const f = fixture(); await commentOnRelease(f);
  assert.equal(await commentOnRelease(f), "cooldown"); assert.equal(f.sent.length, 1);
  const offline = fixture(); offline.config.allowOffline = true; offline.isLive = async () => { throw new Error("should not query"); };
  assert.equal(await commentOnRelease(offline), "sent");
});

test("dropped messages and network ambiguity are failures without automatic retry", async () => {
  for (const send of [async () => ({ ok: true, json: async () => ({ data: [{ is_sent: false, drop_reason: { code: "automod_held" } }] }) }), async () => { throw new Error("timeout"); }]) {
    const f = fixture(); f.send = send; await assert.rejects(commentOnRelease(f));
    assert.equal(await commentOnRelease(f), "cooldown");
  }
});

test("start comment configuration accepts multiple monitored channels independently", () => {
  const config = readAutoCommentConfig({ TWITCH_STREAM_START_COMMENT_ENABLED: "true",
    TWITCH_STREAM_START_COMMENT_CHANNELS: "first,second,FIRST", TWITCH_STREAM_START_COMMENT_MESSAGE: "hello" }, ["first", "second"], "TWITCH_STREAM_START_COMMENT");
  assert.deepEqual(config.channels, ["first", "second"]);
  assert.equal(config.message, "hello");
});

test("start posts once per stream across WS/API duplicates and restart", async () => {
  const f = fixture(); f.current.live = true; f.current.startedAt = "2026-10-17T10:00:00Z"; f.streamKey = "stream-1";
  assert.equal(await commentOnStart(f), "sent");
  assert.equal(await commentOnStart(f), "already-attempted");
  const restarted = { ...f, current: JSON.parse(JSON.stringify(f.current)) };
  assert.equal(await commentOnStart(restarted), "already-attempted");
  assert.equal(f.sent.length, 1);
});

test("each configured channel can post on its own stream start", async () => {
  const f = fixture(); f.config.channels = ["target", "other"];
  f.current.live = true; f.streamKey = "one";
  assert.equal(await commentOnStart(f), "sent");
  f.current = { id: "2", login: "other", live: true }; f.streamKey = "two";
  assert.equal(await commentOnStart(f), "sent");
  assert.deepEqual(f.sent.map(body => body.broadcaster_id), ["1", "2"]);
});

test("start comments skip offline, shared chat and missing permissions", async () => {
  for (const [patch, expected] of [[{ isLive: async () => false }, "offline"], [{ isShared: async () => true }, "shared-chat"], [{ canWrite: false }, "missing-scope"]]) {
    const f = fixture(); f.current.live = true; f.streamKey = "one"; Object.assign(f, patch);
    assert.equal(await commentOnStart(f), expected); assert.equal(f.sent.length, 0);
  }
});

test("concurrent start detections cannot post twice and timeouts are not retried", async () => {
  const f = fixture(); f.current.live = true; f.streamKey = "one";
  await Promise.all([commentOnStart(f), commentOnStart(f)]);
  assert.equal(f.sent.length, 1);
  const failure = fixture(); failure.current.live = true; failure.streamKey = "two";
  failure.send = async () => { throw new Error("timeout"); };
  await assert.rejects(commentOnStart(failure));
  assert.equal(await commentOnStart(failure), "already-attempted");
});

test("release delay is configurable and invalid delays are rejected", () => {
  const env = { TWITCH_EMOTE_RELEASE_COMMENT_ENABLED: "true", TWITCH_EMOTE_RELEASE_COMMENT_CHANNELS: "target", TWITCH_EMOTE_RELEASE_COMMENT_MESSAGE: "hello", TWITCH_EMOTE_RELEASE_COMMENT_DELAY_MS: "15000" };
  assert.equal(readAutoCommentConfig(env, ["target"]).delayMs, 15000);
  for (const delay of ["-1", "NaN", "1.5", "86400001"]) assert.throws(() => readAutoCommentConfig({ ...env, TWITCH_EMOTE_RELEASE_COMMENT_DELAY_MS: delay }, ["target"]), /delay/);
});

test("release waiting is nonblocking and sends only when the delay expires", async () => {
  const timers = [];
  const scheduler = new ReleaseCommentScheduler({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimer() {} });
  const f = fixture(); f.config.delayMs = 15000;
  const done = new Promise((resolve, reject) => {
    scheduler.request(f, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.equal(f.sent.length, 0); assert.equal(timers[0].ms, 15000);
  timers[0].fn(); assert.equal(await done, "sent"); assert.equal(f.sent.length, 1);
});

test("re-enabling cancels a pending release and a later release starts a new delay", async () => {
  const timers = [];
  const scheduler = new ReleaseCommentScheduler({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer() {} });
  const f = fixture(); f.config.delayMs = 10000;
  assert.equal(await scheduler.request(f), "scheduled");
  scheduler.cancel(f.current);
  timers[0].fn(); await Promise.resolve(); assert.equal(f.sent.length, 0);
  const done = new Promise(resolve => { scheduler.request(f, (error, result) => resolve(result)); });
  timers[0].fn(); timers[1].fn(); assert.equal(await done, "sent"); assert.equal(f.sent.length, 1);
});

test("mode recheck prevents posting when emote-only was re-enabled while waiting", async () => {
  const f = fixture(); f.isEmoteDisabled = async () => false;
  assert.equal(await commentOnRelease(f), "mode-changed"); assert.equal(f.sent.length, 0);
});

test("cancellation during preflight prevents a delayed send", async () => {
  let finish, fire;
  const f = fixture(); f.config.delayMs = 10000;
  f.isShared = () => new Promise(resolve => { finish = resolve; });
  const scheduler = new ReleaseCommentScheduler({ setTimer: fn => { fire = fn; }, clearTimer() {} });
  const done = new Promise(resolve => { scheduler.request(f, (error, result) => resolve(result)); });
  fire(); await Promise.resolve(); await Promise.resolve();
  scheduler.cancel(f.current); finish(false);
  assert.equal(await done, "mode-changed"); assert.equal(f.sent.length, 0);
});
