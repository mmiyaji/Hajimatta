const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readAutoCommentConfig, commentOnRelease } = require("../src/auto-comment");

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
