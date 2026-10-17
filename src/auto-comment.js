function readAutoCommentConfig(env, monitored) {
  const enabled = env.TWITCH_EMOTE_RELEASE_COMMENT_ENABLED === "true";
  if (!enabled) return { enabled: false };
  const channels = [...new Set((env.TWITCH_EMOTE_RELEASE_COMMENT_CHANNELS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
  const message = (env.TWITCH_EMOTE_RELEASE_COMMENT_MESSAGE || "").trim();
  const cooldownMs = Number(env.TWITCH_EMOTE_RELEASE_COMMENT_COOLDOWN_MS || 300000);
  const offline = env.TWITCH_EMOTE_RELEASE_COMMENT_ALLOW_OFFLINE || "false";
  if (!channels.length || channels.some(login => !monitored.includes(login))) throw new Error("Auto-comment channels must be included in TWITCH_BROADCASTERS");
  if (!message || [...message].length > 500 || /[\r\n]/.test(message)) throw new Error("Auto-comment message must be a single line of 1–500 characters");
  if (!["true", "false"].includes(offline) || !Number.isFinite(cooldownMs) || cooldownMs < 60000) throw new Error("Invalid auto-comment offline flag or cooldown (minimum 60000 ms)");
  return { enabled, channels, message, allowOffline: offline === "true", cooldownMs };
}

async function commentOnRelease({ config, previous, current, senderId, canWrite, isLive, isShared, send, save, now = Date.now }) {
  if (!config.enabled || !config.channels.includes(current.login?.toLowerCase())
    || previous?.emote_mode !== true || current.chatSettings?.emote_mode !== false) return "not-triggered";
  if (!senderId || !canWrite) return "missing-scope";
  if (current.autoCommentLastAttemptAt && now() - current.autoCommentLastAttemptAt < config.cooldownMs) return "cooldown";
  if (!config.allowOffline && !await isLive()) return "offline";
  if (await isShared()) return "shared-chat";
  // Persist before sending: timeout/crash must not cause an automatic repost.
  // Recheck after the asynchronous live-state request in case another transition ran.
  if (current.chatSettings?.emote_mode !== false) return "mode-changed";
  if (current.autoCommentLastAttemptAt && now() - current.autoCommentLastAttemptAt < config.cooldownMs) return "cooldown";
  current.autoCommentLastAttemptAt = now();
  save();
  const response = await send({ broadcaster_id: current.id, sender_id: senderId, message: config.message });
  if (!response.ok) throw new Error(`Twitch chat send failed: HTTP ${response.status}`);
  const result = (await response.json()).data?.[0];
  if (result?.is_sent !== true) throw new Error(`Twitch chat message not sent: ${result?.drop_reason?.code || "unknown"}`);
  return "sent";
}

module.exports = { readAutoCommentConfig, commentOnRelease };
