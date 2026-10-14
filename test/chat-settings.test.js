const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chatSettingsChanges } = require("../src/chat-settings");

test("emote-only start and end are reported", () => {
  assert.deepEqual(chatSettingsChanges({ emote_mode: false }, { emote_mode: true }), ["スタンプ限定モード: 開始"]);
  assert.deepEqual(chatSettingsChanges({ emote_mode: true }, { emote_mode: false }), ["スタンプ限定モード: 解除"]);
});
test("unchanged and absent modes do not generate notifications", () => {
  assert.deepEqual(chatSettingsChanges({ emote_mode: true }, { emote_mode: true }), []);
  assert.deepEqual(chatSettingsChanges({}, { emote_mode: null }), []);
});
test("initial state is not misreported as a transition", () => {
  assert.deepEqual(chatSettingsChanges(undefined, { emote_mode: false }), ["スタンプ限定モード: 現在無効（初回受信）"]);
});
test("duration updates are reported only while the mode is enabled", () => {
  assert.deepEqual(chatSettingsChanges({ slow_mode: true, slow_mode_wait_time_seconds: 10 }, { slow_mode: true, slow_mode_wait_time_seconds: 30 }), ["スローモード: 待機時間変更（30秒）"]);
  assert.deepEqual(chatSettingsChanges({ follower_mode: false, follower_mode_duration_minutes: 10 }, { follower_mode: false, follower_mode_duration_minutes: null }), []);
});
test("other modes can change together", () => {
  assert.deepEqual(chatSettingsChanges({ subscriber_mode: false, unique_chat_mode: true }, { subscriber_mode: true, unique_chat_mode: false }), ["サブスク限定モード: 開始", "重複メッセージ制限モード: 解除"]);
});
