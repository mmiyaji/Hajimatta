const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class SlackOutbox {
  constructor(file, { send, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.file = file; this.send = send; this.log = log; this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.stopped = true; this.running = null; this.nextSendAt = 0;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, items: [], alerts: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.items) || !this.data.alerts || typeof this.data.alerts !== "object"
      || (this.data.pausedUntil !== undefined && !Number.isFinite(this.data.pausedUntil))
      || Object.values(this.data.alerts).some(alert => !alert || !Number.isFinite(alert.firstSeenAt)
        || !(alert.lastQueuedAt === null || Number.isFinite(alert.lastQueuedAt)) || typeof alert.detail !== "string")
      || this.data.items.some(item => !item.id || !item.payload || !Number.isFinite(item.nextAttemptAt) || !Number.isInteger(item.attempts) || item.attempts < 0)) {
      throw new Error("Invalid Slack outbox file; preserve it and repair before restarting");
    }
  }

  commit(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "w", 0o600);
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      this.data = data;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  enqueue(payload, { key = null, alerts = this.data.alerts } = {}) {
    // Clone before persistence so caller mutations cannot change a queued notification.
    const item = { id: randomUUID(), key, payload: JSON.parse(JSON.stringify(payload)), createdAt: this.now(), attempts: 0, nextAttemptAt: this.now() };
    const existing = key && this.data.items.find(entry => entry.key === key);
    this.commit({ ...this.data, alerts, items: existing ? this.data.items : [...this.data.items, item] });
    this.schedule();
    return existing?.id || item.id;
  }

  updateAlerts(alerts) { this.commit({ ...this.data, alerts }); }
  start() { this.stopped = false; this.schedule(); }
  schedule() {
    if (this.stopped || this.running) return;
    this.clearTimer(this.timer);
    if (!this.data.items.length) return;
    const next = Math.max(this.nextSendAt, this.data.pausedUntil || 0,
      this.data.items.reduce((earliest, item) => Math.min(earliest, item.nextAttemptAt), Infinity));
    this.timer = this.setTimer(() => { void this.flush(); }, Math.min(2147483647, Math.max(0, next - this.now())));
  }

  async flush() {
    if (this.running) return this.running;
    const item = this.data.items.find(entry => entry.nextAttemptAt <= this.now());
    if (!item || this.stopped || Math.max(this.nextSendAt, this.data.pausedUntil || 0) > this.now()) { this.schedule(); return; }
    this.running = (async () => {
      let failure;
      try { await this.send(item.payload); } catch (error) { failure = error; }
      if (!failure) {
        this.commit({ ...this.data, items: this.data.items.filter(entry => entry.id !== item.id) });
        this.log("info", `Slack notification delivered: id=${item.id} attempts=${item.attempts + 1}`);
      } else {
        const attempts = item.attempts + 1;
        const permanent = failure.status >= 400 && failure.status < 500 && failure.status !== 429 && failure.status !== 408;
        const delay = Math.max(permanent ? 3600000 : Math.min(900000, 5000 * 2 ** Math.min(attempts - 1, 8)), failure.retryAfterMs || 0);
        this.commit({ ...this.data,
          pausedUntil: failure.status === 429 ? this.now() + Math.max(1000, failure.retryAfterMs || 60000) : this.data.pausedUntil || 0,
          items: this.data.items.map(entry => entry.id !== item.id ? entry : {
          ...entry, attempts, nextAttemptAt: this.now() + delay, lastStatus: failure.status || "network",
        }) });
        this.log("warn", `Slack delivery deferred: id=${item.id} status=${failure.status || "network"} attempts=${attempts} retryInSec=${Math.ceil(delay / 1000)} pending=${this.data.items.length}`);
      }
      this.nextSendAt = this.now() + 1000;
    })();
    try { await this.running; }
    catch { this.log("error", "Slack outbox persistence failed; stopping delivery to preserve pending notifications"); this.stopped = true; }
    finally { this.running = null; this.schedule(); }
  }

  async close() { this.stopped = true; this.clearTimer(this.timer); if (this.running) await this.running; }
  status() {
    return { pending: this.data.items.length, retrying: this.data.items.filter(item => item.attempts > 0).length, stopped: this.stopped };
  }
}

async function sendSlackWebhook(url, payload, request = fetch) {
  let response;
  try {
    response = await request(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    if (response.ok) { await response.text(); return; }
    await response.text();
  } catch { throw new Error("Slack network request failed"); }
  const error = new Error(`Slack webhook HTTP ${response.status}`);
  error.status = response.status;
  const retryAfter = Number(response.headers?.get("Retry-After"));
  error.retryAfterMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0;
  throw error;
}

module.exports = { SlackOutbox, sendSlackWebhook };
