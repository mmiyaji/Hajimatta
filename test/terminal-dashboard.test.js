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
  assert.match(text, /channel \| LIVE \| online=other_session/);
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
