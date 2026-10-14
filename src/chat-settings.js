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

module.exports = { chatSettingsChanges };
