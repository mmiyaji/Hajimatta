const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { dashboardLines, startDashboard, formatElapsed } = require("../src/terminal-dashboard");

test("fixed view includes connection, cost, coverage and sanitized warnings", () => {
  const lines = dashboardLines({ connection: "connected", reportAt: "12:00", report: {
    totalCost: 10, maxTotalCost: 10, enabledWebSockets: 2,
    coverage: [{ broadcasterId: "1", type: "stream.online", status: "other_session" }],
  }, broadcasters: [{ id: "1", login: "channel", live: true }] }, ["error\x1b[2J\nmessage"]);
  const text = lines.join("\n");
  assert.match(text, /Cost: 10\/10/);
  assert.match(text, /channel\s+\| \[LIVE\]\s+\| unknown\s+\| \[OTHER\]/);
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

test("table columns align for different names, stream states and subscription states", () => {
  const broadcasters = [{ id: "1", login: "a", live: true }, { id: "2", login: "long_channel_name", live: false }];
  const report = { coverage: broadcasters.flatMap(b => ["stream.online", "channel.update", "channel.chat_settings.update"].map((type, i) => ({
    broadcasterId: b.id, type, status: ["enabled", "missing", "other_session"][i],
  }))) };
  const lines = dashboardLines({ broadcasters, report }, [], { width: 160, height: 24 });
  const table = lines.slice(7, 10);
  const separators = line => [...line.matchAll(/\|/g)].map(match => match.index);
  assert.equal(table[0].trim().startsWith("CHANNEL"), true);
  assert.deepEqual(separators(table[0]), separators(table[1]));
  assert.deepEqual(separators(table[0]), separators(table[2]));
  assert.match(table[1], /\[LIVE\]/);
  assert.match(table[2], /\[OFF\]/);
});

test("live rows show category and title on one clipped line, offline rows hide stale details", () => {
  const snapshot = { broadcasters: [
    { id: "1", login: "streamer", live: true, categoryName: "Just Chatting", title: "配信タイトル".repeat(30) },
    { id: "2", login: "offline", live: false, categoryName: "Old category", title: "Old title" },
  ] };
  const wide = dashboardLines(snapshot, [], { width: 140, height: 24 });
  assert.match(wide[7], /CATEGORY\s+\| TITLE/);
  assert.match(wide[8], /Just Chatting\s+\| 配信タイトル/);
  assert.ok(!wide[9].includes("Old category"));
  assert.ok(!wide[9].includes("Old title"));
  const narrow = dashboardLines(snapshot, [], { width: 90, height: 24 });
  assert.equal(narrow.length, wide.length);
  assert.match(narrow[9], /offline/);
  assert.ok([...narrow[8]].reduce((sum, char) => sum + (char.codePointAt(0) > 127 ? 2 : 1), 0) <= 90);
});

test("shorter redraws erase previous characters from every terminal row", () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  const output = new EventEmitter();
  const frames = [];
  Object.assign(output, { isTTY: true, rows: 24, columns: 100, write(text) { frames.push(text); } });
  const snapshot = { connection: "disconnected / reconnecting", broadcasters: [{ id: "1", login: "channel", live: true }],
    report: { coverage: [{ broadcasterId: "1", type: "stream.online", status: "missing" }] } };
  const dashboard = startDashboard(() => snapshot, { input, output, quit() {} });
  // Model overwrite semantics: writing a shorter line does not erase its old tail.
  const apply = (previous, frame) => frame.replace(/^\x1b\[H/, "").replace(/\x1b\[J$/, "").split("\r\n").map((line, i) => {
    const erased = line.startsWith("\x1b[2K");
    const text = line.replace(/\x1b\[(?:2K|[\d;]*m)/g, "");
    return text + (erased ? "" : (previous[i] || "").slice(text.length));
  });
  try {
    const oldRows = apply([], frames.at(-1));
    snapshot.connection = "connected";
    snapshot.broadcasters[0].live = false;
    snapshot.report.coverage[0].status = "enabled";
    output.emit("resize");
    const rows = apply(oldRows, frames.at(-1));
    assert.ok(rows[1].endsWith("WS: connected"));
    assert.ok(!rows.join("\n").includes("[MISS]"));
    assert.ok(!rows.join("\n").includes("[LIVE]"));
    assert.ok(frames.at(-1).split("\r\n").slice(1).every(line => line.startsWith("\x1b[2K")));
  } finally { dashboard.close(); }
});

test("elapsed time uses stream start while live and observed end while offline", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(formatElapsed({ live: true, startedAt: "2026-10-15T10:29:55Z" }, now), "01:30:05");
  assert.equal(formatElapsed({ live: false, lastOfflineAt: "2026-10-13T11:00:00Z" }, now), "~2d 01:00:00");
  for (const timestamp of [undefined, "invalid", "2026-10-16T12:00:00Z"]) {
    assert.equal(formatElapsed({ live: true, startedAt: timestamp }, now), "unknown");
  }
  assert.equal(formatElapsed({ live: false, startedAt: "2026-10-15T10:00:00Z" }, now), "unknown");
});

test("elapsed column advances without changing the table layout", () => {
  const snapshot = { broadcasters: [{ id: "1", login: "channel", live: true, startedAt: "2026-10-15T10:00:00Z" }] };
  const first = dashboardLines(snapshot, [], { now: Date.parse("2026-10-15T11:00:00Z"), width: 140 });
  const second = dashboardLines(snapshot, [], { now: Date.parse("2026-10-15T11:00:01Z"), width: 140 });
  assert.match(first[8], /01:00:00/);
  assert.match(second[8], /01:00:01/);
  assert.equal(first.length, second.length);
});

test("emote-only state is visible separately from the chat subscription", () => {
  const snapshot = { broadcasters: [{ id: "1", login: "on", emoteMode: true }, { id: "2", login: "off", emoteMode: false }] };
  const lines = dashboardLines(snapshot, [], { width: 160 });
  assert.match(lines[7], /EMOTES/);
  assert.match(lines[8], /\[EMOTE\]/);
  assert.match(lines[9], /\[TEXT\]/);
});

test("log levels include higher severity and always include fatal errors", () => {
  const entries = ["info", "warn", "error", "fatal"].map(level => ({ level, text: `entry-${level}` }));
  for (const [logLevel, expected] of [["info", entries], ["warn", entries.slice(1)], ["error", entries.slice(2)]]) {
    const text = dashboardLines({}, entries, { logLevel }).join("\n");
    for (const entry of entries) assert.equal(text.includes(entry.text), expected.includes(entry));
    assert.ok(text.includes(`LOGS: ${logLevel.toUpperCase()}+`));
  }
});

test("keyboard filtering redraws retained INFO history without refreshing data", () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  const frames = [];
  const output = { isTTY: true, rows: 24, columns: 100, write(text) { frames.push(text); } };
  const dashboard = startDashboard(() => ({}), { input, output });
  try {
    dashboard.log("info", "information-message");
    dashboard.log("warn", "warning-message");
    dashboard.log("error", "error-message");
    assert.ok(!frames.at(-1).includes("information-message"));
    input.emit("data", Buffer.from("1"));
    assert.ok(frames.at(-1).includes("information-message"));
    input.emit("data", Buffer.from("3"));
    assert.ok(!frames.at(-1).includes("warning-message"));
    assert.ok(frames.at(-1).includes("error-message"));
    input.emit("data", Buffer.from("l"));
    assert.ok(frames.at(-1).includes("LOGS: INFO+"));
    assert.ok(frames.at(-1).includes("information-message"));
    input.emit("data", Buffer.from("2"));
    assert.ok(frames.at(-1).includes("LOGS: WARN+"));
  } finally { dashboard.close(); }
});

function dashboardFixture(t) {
  const input = new EventEmitter(), output = new EventEmitter(), frames = [];
  const snapshot = { broadcasters: [{ id: "1", login: "channel", live: false }] };
  Object.assign(input, { isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  Object.assign(output, { isTTY: true, rows: 18, columns: 160, write(text) { frames.push(text); } });
  const dashboard = startDashboard(() => snapshot, { input, output, quit() {} });
  t.after(() => dashboard.close());
  return { dashboard, snapshot, key: key => input.emit("data", Buffer.from(key)),
    view: () => frames.at(-1).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""), redraw: () => output.emit("resize") };
}

test("pause freezes log rows while collection and channel status continue", t => {
  const f = dashboardFixture(t);
  f.dashboard.log("warn", "before-pause"); f.key("p");
  f.dashboard.log("warn", "after-pause"); f.snapshot.broadcasters[0].live = true; f.redraw();
  assert.match(f.view(), /\[PAUSED\] new=1/);
  assert.match(f.view(), /\[LIVE\]/);
  assert.ok(!f.view().includes("after-pause"));
  f.key("p"); assert.match(f.view(), /after-pause/); assert.match(f.view(), /\[FOLLOW\]/);
});

test("split PageUp/Home sequences scroll history without changing the filter", t => {
  const f = dashboardFixture(t);
  for (let i = 0; i < 40; i++) f.dashboard.log("warn", `entry-${String(i).padStart(2, "0")}`);
  assert.match(f.view(), /entry-39/);
  f.key("\x1b["); f.key("5~");
  assert.ok(!f.view().includes("entry-39"));
  assert.match(f.view(), /LOGS: WARN\+/);
  f.key("\x1b[1~"); assert.match(f.view(), /entry-00/); assert.match(f.view(), /LOGS: WARN\+/);
  f.dashboard.log("warn", "new-while-reading"); assert.ok(!f.view().includes("new-while-reading"));
  f.key("\x1b[F"); assert.match(f.view(), /new-while-reading/); assert.match(f.view(), /\[FOLLOW\]/);
});

test("freshness markers use actual sample ages and Slack inactivity is not stale", () => {
  const lines = dashboardLines({ freshness: { startedAt: 100000, wsReceivedAt: 100000, chatCheckedAt: 160000, streamCheckedAt: 100000 },
    slack: { pending: 0, retrying: 0, lastDeliveredAt: 1000 } }, [], { now: 170000, width: 160 });
  assert.match(lines[3], /WS \[STALE\] 1m/);
  assert.match(lines[3], /CHAT \[FRESH\] 10s/);
  assert.ok(!lines[5].includes("STALE"));
});
