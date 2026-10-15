const modes = [
  ["emote_mode", "スタンプ限定モード"],
  ["follower_mode", "フォロワー限定モード", "follower_mode_duration_minutes", "分"],
  ["subscriber_mode", "サブスク限定モード"],
  ["slow_mode", "スローモード", "slow_mode_wait_time_seconds", "秒"],
  ["unique_chat_mode", "重複メッセージ制限モード"],
];

function chatSettingsChanges(previous, current) {
  const changes = [];
  for (const [key, label, durationKey, unit] of modes) {
    if (typeof current[key] !== "boolean") continue;
    const known = typeof previous?.[key] === "boolean";
    const enabled = current[key];
    const durationChanged = enabled && durationKey && previous?.[durationKey] !== current[durationKey];
    if (known && previous[key] === enabled && !durationChanged) continue;
    const action = !known ? `現在${enabled ? "有効" : "無効"}（初回受信）`
      : previous[key] === enabled ? "待機時間変更" : enabled ? "開始" : "解除";
    const duration = enabled && durationKey && Number.isFinite(current[durationKey])
      ? `（${current[durationKey]}${unit}）` : "";
    changes.push(`${label}: ${action}${duration}`);
  }
  return changes;
}

function normalizeApiChatSettings(settings, broadcaster) {
  if (!settings || settings.broadcaster_id !== broadcaster.id || typeof settings.emote_mode !== "boolean") {
    throw new Error("Invalid chat settings API response");
  }
  return {
    broadcaster_user_id: broadcaster.id, broadcaster_user_login: broadcaster.login,
    broadcaster_user_name: broadcaster.displayName || broadcaster.login,
    emote_mode: settings.emote_mode, follower_mode: settings.follower_mode,
    follower_mode_duration_minutes: settings.follower_mode_duration,
    subscriber_mode: settings.subscriber_mode, slow_mode: settings.slow_mode,
    slow_mode_wait_time_seconds: settings.slow_mode_wait_time,
    unique_chat_mode: settings.unique_chat_mode,
  };
}

module.exports = { chatSettingsChanges, normalizeApiChatSettings };
