function readAutoCommentConfig(env, monitored, prefix = "TWITCH_EMOTE_RELEASE_COMMENT") {
  const enabled = env[`${prefix}_ENABLED`] === "true";
  if (!enabled) return { enabled: false };
  const channels = [...new Set((env[`${prefix}_CHANNELS`] || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
  const message = (env[`${prefix}_MESSAGE`] || "").trim();
  let messages = [message];
  if (env[`${prefix}_MESSAGES`]?.trim()) {
    try { messages = JSON.parse(env[`${prefix}_MESSAGES`]); }
    catch { throw new Error(`${prefix}_MESSAGES must be a JSON array of messages`); }
  }
  const cooldownMs = Number(env[`${prefix}_COOLDOWN_MS`] || 300000);
  const offline = env[`${prefix}_ALLOW_OFFLINE`] || "false";
  const delayMs = Number(env[`${prefix}_DELAY_MS`] || 0);
  if (!channels.length || channels.some(login => !monitored.includes(login))) throw new Error("Auto-comment channels must be included in TWITCH_BROADCASTERS");
  if (!Array.isArray(messages) || !messages.length || messages.some(value => typeof value !== "string" || !value.trim() || [...value.trim()].length > 500 || /[\r\n]/.test(value))) throw new Error("Auto-comment messages must be a nonempty array of single lines of 1–500 characters");
  messages = messages.map(value => value.trim());
  if (!["true", "false"].includes(offline) || !Number.isFinite(cooldownMs) || cooldownMs < 60000) throw new Error("Invalid auto-comment offline flag or cooldown (minimum 60000 ms)");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 86400000) throw new Error("Auto-comment delay must be 0–86400000 ms");
  return { enabled, channels, message, messages, allowOffline: offline === "true", cooldownMs, delayMs };
}

function selectMessage(config, random) {
  const messages = config.messages || [config.message];
  return messages[Math.floor(random() * messages.length)];
}

async function commentOnRelease({ config, previous, current, senderId, canWrite, isLive, isShared, isEmoteDisabled = async () => true, isCurrent = () => true, send, save, now = Date.now, random = Math.random }) {
  if (!config.enabled || !config.channels.includes(current.login?.toLowerCase())
    || previous?.emote_mode !== true || current.chatSettings?.emote_mode !== false) return "not-triggered";
  if (!senderId || !canWrite) return "missing-scope";
  if (current.autoCommentLastAttemptAt && now() - current.autoCommentLastAttemptAt < config.cooldownMs) return "cooldown";
  if (!config.allowOffline && !await isLive()) return "offline";
  if (await isShared()) return "shared-chat";
  if (!await isEmoteDisabled()) return "mode-changed";
  // Persist before sending: timeout/crash must not cause an automatic repost.
  // Recheck after the asynchronous live-state request in case another transition ran.
  if (!isCurrent() || current.chatSettings?.emote_mode !== false) return "mode-changed";
  if (current.autoCommentLastAttemptAt && now() - current.autoCommentLastAttemptAt < config.cooldownMs) return "cooldown";
  current.autoCommentLastAttemptAt = now();
  save();
  const response = await send({ broadcaster_id: current.id, sender_id: senderId, message: selectMessage(config, random) });
  if (!response.ok) throw new Error(`Twitch chat send failed: HTTP ${response.status}`);
  const result = (await response.json()).data?.[0];
  if (result?.is_sent !== true) throw new Error(`Twitch chat message not sent: ${result?.drop_reason?.code || "unknown"}`);
  return "sent";
}

async function commentOnStart({ config, current, streamKey, senderId, canWrite, isLive, isShared, send, save, now = Date.now, random = Math.random }) {
  if (!config.enabled || !config.channels.includes(current.login?.toLowerCase()) || !streamKey || !current.live) return "not-triggered";
  if (!senderId || !canWrite) return "missing-scope";
  const startedAt = current.startedAt;
  const duplicate = () => current.startCommentStreamKey === streamKey;
  if (duplicate()) return "already-attempted";
  if (!await isLive()) return "offline";
  if (await isShared()) return "shared-chat";
  if (!current.live || current.startedAt !== startedAt) return "stream-changed";
  if (duplicate()) return "already-attempted";
  if (current.startCommentLastAttemptAt && now() - current.startCommentLastAttemptAt < config.cooldownMs) return "cooldown";
  current.startCommentStreamKey = streamKey;
  current.startCommentLastAttemptAt = now(); save();
  const response = await send({ broadcaster_id: current.id, sender_id: senderId, message: selectMessage(config, random) });
  if (!response.ok) throw new Error(`Twitch chat send failed: HTTP ${response.status}`);
  const result = (await response.json()).data?.[0];
  if (result?.is_sent !== true) throw new Error(`Twitch chat message not sent: ${result?.drop_reason?.code || "unknown"}`);
  return "sent";
}

class ReleaseCommentScheduler {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.jobs = new WeakMap(); this.setTimer = setTimer; this.clearTimer = clearTimer;
  }
  cancel(current) {
    const job = this.jobs.get(current);
    if (job) this.clearTimer(job.timer);
    this.jobs.delete(current);
  }
  async request(options, onComplete = () => {}) {
    const { config, previous, current } = options;
    if (!config.enabled || !config.channels.includes(current.login?.toLowerCase())
      || previous?.emote_mode !== true || current.chatSettings?.emote_mode !== false) return "not-triggered";
    this.cancel(current);
    if (!config.delayMs) return commentOnRelease(options);
    if (!options.canWrite || !options.senderId) return "missing-scope";
    const job = {};
    this.jobs.set(current, job);
    job.timer = this.setTimer(() => {
      if (this.jobs.get(current) !== job) return;
      void commentOnRelease({ ...options, isCurrent: () => this.jobs.get(current) === job })
        .then(result => onComplete(null, result), error => onComplete(error))
        .finally(() => { if (this.jobs.get(current) === job) this.jobs.delete(current); });
    }, config.delayMs);
    job.timer?.unref?.();
    return "scheduled";
  }
}

module.exports = { readAutoCommentConfig, commentOnRelease, commentOnStart, ReleaseCommentScheduler };
