function freshnessLabel(timestamp, limitMs, now = Date.now(), startedAt = now) {
  if (!Number.isFinite(timestamp)) return now - startedAt > limitMs ? "[STALE] never" : "[WAIT]";
  const age = Math.max(0, now - timestamp);
  const seconds = Math.floor(age / 1000);
  const duration = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return `${age > limitMs ? "[STALE]" : "[FRESH]"} ${duration}`;
}

module.exports = { freshnessLabel };
