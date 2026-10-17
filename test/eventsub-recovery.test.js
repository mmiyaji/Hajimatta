const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function harness() {
  const sockets = [];
  const timers = new Set();
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; sockets.push(this); }
    terminate() { this.terminated = true; this.emit("close", 1006, ""); }
    close() { this.closed = true; this.emit("close", 1000, ""); }
    async message(type, keepalive = 10) {
      const payload = { metadata: { message_type: type }, payload: { session: { id: "session", keepalive_timeout_seconds: keepalive } } };
      await Promise.all(this.listeners("message").map(fn => fn(JSON.stringify(payload))));
    }
  }
  const context = vm.createContext({
    WebSocket: Socket, setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer), log() {},
  });
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  vm.runInContext(`
    const WS_CONNECT_TIMEOUT_MS = 15000, WS_SETUP_TIMEOUT_MS = 30000;
    const EVENTSUB_WS_URL = "normal";
    const config = { reconnectDelayMs: 5000 };
    let websocket = null, keepaliveTimer = null, reconnectTimer = null, keepaliveTimeoutSeconds = 10;
    let eventsubReady = false;
    const freshness = {};
    const seenMessageIds = new Set();
    let registrations = 0, notifications = 0;
    ${source.slice(source.indexOf("async function connect("), source.indexOf("async function cleanupManagedSubscriptions("))}
    ${source.slice(source.indexOf("async function reconnectTo("), source.indexOf("async function ensureValidUserAccessToken("))}
    ${source.slice(source.indexOf("function resetKeepaliveTimeout("), source.indexOf("function displayNameOf("))}
    registerSubscriptions = async () => { registrations++; eventsubReady = true; };
    async function handleNotification() { notifications++; }
  `, context);
  return { sockets, timers, run: code => vm.runInContext(code, context) };
}

test("stalled connection or welcome is terminated and retried", async () => {
  for (const opened of [false, true]) {
    const h = harness(); await h.run('connect("normal")');
    if (opened) h.sockets[0].emit("open");
    [...h.timers].find(t => t.ms === 30000).fn();
    assert.equal(h.sockets[0].terminated, true);
    [...h.timers].find(t => t.ms === 5000).fn();
    assert.equal(h.sockets.length, 2);
  }
});

test("periodic reconnect is disabled by default without disabling failure recovery", async () => {
  const h = harness(); await h.run('connect("normal")');
  await h.sockets[0].message("session_welcome");
  assert.equal(h.sockets[0].periodicReconnectTimer, undefined);
  h.sockets[0].terminate();
  assert.equal([...h.timers].some(t => t.ms === 5000), true);
});

test("optional periodic reconnect starts after setup and resets on transfer", async () => {
  const h = harness(); h.run("config.periodicReconnectIntervalMs = 3600000");
  await h.run('connect("normal")');
  assert.equal([...h.timers].some(t => t.ms === 3600000), false);
  await h.sockets[0].message("session_welcome");
  const first = h.sockets[0].periodicReconnectTimer;
  assert.equal(h.timers.has(first), true);
  await h.run('reconnectTo("transfer")');
  assert.equal(h.timers.has(first), false);
  first.fn(); assert.equal(h.sockets[1].terminated, undefined);
  await h.sockets[1].message("session_welcome", null);
  h.sockets[1].periodicReconnectTimer.fn();
  assert.equal(h.sockets[1].terminated, true);
  assert.equal([...h.timers].some(t => t.ms === 5000), true);
});

test("socket error retries even without a subsequent close event", async () => {
  const h = harness(); await h.run('connect("normal")');
  h.sockets[0].terminate = () => {};
  h.sockets[0].emit("error", new Error("network unavailable"));
  assert.equal([...h.timers].filter(t => t.ms === 5000).length, 1);
});

test("transfer keeps receiving old notifications until welcome and preserves subscriptions", async () => {
  const h = harness(); await h.run('connect("normal")');
  await h.sockets[0].message("session_welcome");
  await h.run('reconnectTo("transfer")');
  assert.equal(h.sockets[0].closed, undefined);
  await h.sockets[0].message("notification");
  assert.equal(h.run("notifications"), 1);
  await h.sockets[1].message("session_welcome", null);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.run("registrations"), 1);
  assert.equal([...h.timers].some(t => t.ms === 30000), false);
  assert.equal([...h.timers].some(t => t.ms === 60000), true);
});

test("notifications refresh liveness and dead sockets are terminated", async () => {
  const h = harness(); await h.run('connect("normal")');
  await h.sockets[0].message("session_welcome");
  const oldTimer = [...h.timers].find(t => t.ms === 60000);
  await h.sockets[0].message("notification");
  assert.equal(h.timers.has(oldTimer), false);
  [...h.timers].find(t => t.ms === 60000).fn();
  assert.equal(h.sockets[0].terminated, true);
  assert.equal([...h.timers].some(t => t.ms === 5000), true);
});

test("subscription setup failure triggers a fresh connection", async () => {
  const h = harness(); await h.run('connect("normal")');
  h.run('registerSubscriptions = async () => { throw new Error("API unavailable"); }');
  await h.sockets[0].message("session_welcome");
  assert.equal(h.sockets[0].terminated, true);
  assert.equal([...h.timers].some(t => t.ms === 5000), true);
});

test("hung subscription request cannot block recovery or mark an obsolete session ready", async () => {
  const h = harness(); await h.run('connect("normal")');
  h.run('registerSubscriptions = () => new Promise(resolve => { globalThis.finishSetup = resolve; });');
  const pending = h.sockets[0].message("session_welcome");
  [...h.timers].find(t => t.ms === 30000).fn();
  [...h.timers].find(t => t.ms === 5000).fn();
  h.run("finishSetup()"); await pending;
  assert.equal(h.sockets[0].terminated, true);
  assert.equal(h.sockets[1].subscriptionsReady, undefined);
  assert.equal([...h.timers].some(t => t.ms === 30000), true);
});
