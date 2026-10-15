class HealthAlerts {
  constructor(outbox, { now = Date.now, thresholdMs = 60000, repeatMs = 7200000 } = {}) {
    this.outbox = outbox; this.now = now; this.thresholdMs = thresholdMs; this.repeatMs = repeatMs;
  }

  set(key, detail, immediate = false) {
    const alerts = { ...this.outbox.data.alerts };
    const previous = alerts[key];
    if (detail === null) {
      if (!previous) return;
      delete alerts[key];
      if (previous.lastQueuedAt !== null) {
        this.outbox.enqueue({ text: `[Hajimatta 復旧] ${key}\n検知: ${new Date(previous.firstSeenAt).toISOString()}\n復旧確認: ${new Date(this.now()).toISOString()}` }, { alerts });
      } else this.outbox.updateAlerts(alerts);
      return;
    }
    // Only fixed operational descriptions belong here, never raw tokens or HTTP bodies.
    alerts[key] = { firstSeenAt: previous?.firstSeenAt ?? this.now(), lastQueuedAt: previous?.lastQueuedAt ?? null, detail };
    const current = alerts[key];
    if ((immediate || this.now() - current.firstSeenAt >= this.thresholdMs)
      && (current.lastQueuedAt === null || this.now() - current.lastQueuedAt >= this.repeatMs)) {
      current.lastQueuedAt = this.now();
      this.outbox.enqueue({ text: `[Hajimatta 異常] ${key}\n${detail}\n検知: ${new Date(current.firstSeenAt).toISOString()}\n通知作成: ${new Date(this.now()).toISOString()}` }, { key: `health:${key}`, alerts });
    } else if (!previous || previous.detail !== detail) this.outbox.updateAlerts(alerts);
  }

  tick() { for (const [key, value] of Object.entries(this.outbox.data.alerts)) this.set(key, value.detail); }
}

module.exports = { HealthAlerts };
