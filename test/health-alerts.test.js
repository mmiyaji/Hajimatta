const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SlackOutbox } = require("../src/slack-outbox");
const { HealthAlerts } = require("../src/health-alerts");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hajimatta-health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100000;
  const file = path.join(dir, "queue.json");
  const now = () => time;
  const queue = new SlackOutbox(file, { send: async () => {}, now });
  return { queue, file, now, health: new HealthAlerts(queue, { now }), advance: ms => { time += ms; } };
}

test("brief faults stay quiet; sustained faults alert once and recovery is queued", t => {
  const f = fixture(t);
  f.health.set("WS", "disconnected"); f.advance(30000); f.health.set("WS", null);
  assert.equal(f.queue.data.items.length, 0);
  f.health.set("WS", "disconnected"); f.advance(60000); f.health.tick();
  assert.equal(f.queue.data.items.length, 1);
  f.health.tick(); assert.equal(f.queue.data.items.length, 1);
  f.health.set("WS", null);
  assert.equal(f.queue.data.items.length, 2);
  assert.match(f.queue.data.items[1].payload.text, /復旧/);
});

test("alert timestamps persist, throttle across restart, and coalesce undelivered alerts", t => {
  const f = fixture(t);
  f.health.set("auth", "invalid", true);
  const restarted = new SlackOutbox(f.file, { send: async () => {}, now: f.now });
  const health = new HealthAlerts(restarted, { now: f.now });
  health.set("auth", "invalid", true);
  assert.equal(restarted.data.items.length, 1);
  f.advance(7200000); health.tick();
  assert.equal(restarted.data.items.length, 1);
  assert.equal(restarted.data.alerts.auth.lastQueuedAt, f.now());
});

test("a still-failing condition repeats after the cooldown if its alert was delivered", t => {
  const f = fixture(t); f.health.set("API", "offline", true);
  f.queue.commit({ ...f.queue.data, items: [] });
  f.advance(7200000); f.health.tick();
  assert.equal(f.queue.data.items.length, 1);
  assert.match(f.queue.data.items[0].payload.text, /API/);
});
