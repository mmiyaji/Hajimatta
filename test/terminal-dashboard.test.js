const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { dashboardLines, startDashboard } = require("../src/terminal-dashboard");

test("fixed view includes connection, cost, coverage and sanitized warnings", () => {
  const lines = dashboardLines({ connection: "connected", reportAt: "12:00", report: {
    totalCost: 10, maxTotalCost: 10, enabledWebSockets: 2,
    coverage: [{ broadcasterId: "1", type: "stream.online", status: "other_session" }],
  }, broadcasters: [{ id: "1", login: "channel", live: true }] }, ["error\x1b[2J\nmessage"]);
  const text = lines.join("\n");
  assert.match(text, /Cost: 10\/10/);
  assert.match(text, /\[LIVE\] channel \| online\[OTHER\]/);
  assert.equal(lines.some(line => /[\x00-\x1f]/.test(line)), false);
});

test("non-interactive output never emits terminal escapes", () => {
  assert.equal(startDashboard(() => ({}), { input: { isTTY: false }, output: { isTTY: false } }), null);
});

test("quit restores terminal mode and removes input listener", () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  let output = "", quit = false;
  const dashboard = startDashboard(() => ({ connection: "connecting", broadcasters: [] }), {
    input, output: { isTTY: true, columns: 80, rows: 24, write(text) { output += text; } },
    quit() { quit = true; },
  });
  try {
    assert.equal(input.isRaw, true);
    dashboard.log("error", "test warning");
    assert.match(output, /test warning/);
    input.emit("data", Buffer.from("q"));
    assert.equal(quit, true);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
    assert.ok(output.endsWith("\x1b[?25h\x1b[?1049l"));
  } finally { dashboard.close(); }
});

test("remaining window height is used for logs, retaining more than five entries", () => {
  const snapshot = { connection: "connected", broadcasters: [{ id: "1", login: "channel", live: false }] };
  const recent = Array.from({ length: 60 }, (_, i) => `warning-${String(i).padStart(2, "0")}`);
  const small = dashboardLines(snapshot, recent, { height: 20, width: 99 });
  const tall = dashboardLines(snapshot, recent, { height: 40, width: 99 });
  assert.equal(small.length, 20);
  assert.equal(tall.length, 40);
  assert.ok(tall.filter(line => line.startsWith("warning-")).length > small.filter(line => line.startsWith("warning-")).length);
  assert.ok(tall.filter(line => line.startsWith("warning-")).length > 5);
  assert.equal(small.at(-1), "warning-59");
  assert.equal(tall.at(-1), "warning-59");
});

test("long logs wrap to terminal width and tiny windows stay bounded", () => {
  const lines = dashboardLines({ connection: "connected" }, ["日本語の長いエラーメッセージ".repeat(5)], { height: 24, width: 20 });
  assert.equal(lines.length, 24);
  assert.ok(lines.every(line => [...line].reduce((n, char) => n + (char.codePointAt(0) > 127 ? 2 : 1), 0) <= 20));
  assert.equal(dashboardLines({}, [], { height: 1, width: 1 }).length, 1);
});

test("resize redraws immediately, restores history, and colors status markers", () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  const output = new EventEmitter();
  const frames = [];
  Object.assign(output, { isTTY: true, rows: 18, columns: 100, write(text) { frames.push(text); } });
  const snapshot = { connection: "connected", broadcasters: [{ id: "1", login: "live", live: true }, { id: "2", login: "off", live: false }], report: {
    coverage: [{ broadcasterId: "1", type: "stream.online", status: "enabled" }, { broadcasterId: "2", type: "stream.online", status: "missing" }],
  } };
  const dashboard = startDashboard(() => snapshot, { input, output, quit() {} });
  try {
    for (let i = 0; i < 25; i++) dashboard.log("warn", `entry-${String(i).padStart(2, "0")}`);
    const before = frames.at(-1);
    assert.ok(before.includes("\x1b[1;32m[LIVE]"));
    assert.ok(before.includes("\x1b[90m[OFF]"));
    assert.ok(before.includes("\x1b[1;31m[MISS]"));
    assert.ok(!before.includes("entry-00"));
    output.rows = 45;
    output.emit("resize");
    assert.ok(frames.at(-1).includes("entry-00"));
    output.columns = 30;
    output.emit("resize");
    assert.equal(frames.at(-1).split("\r\n").length, 45);
  } finally { dashboard.close(); }
  assert.equal(output.listenerCount("resize"), 0);
});
