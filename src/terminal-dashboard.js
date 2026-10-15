const { freshnessLabel } = require("./freshness");

function clean(value) {
  return String(value ?? "-").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function wrapLine(value, width) {
  const lines = [];
  let line = "", cells = 0;
  for (const char of clean(value)) {
    const size = /\p{Mark}/u.test(char) ? 0 : char.codePointAt(0) > 127 ? 2 : 1;
    if (cells + size > width && line) { lines.push(line); line = ""; cells = 0; }
    if (size > width) continue;
    line += char; cells += size;
  }
  lines.push(line);
  return lines;
}

function tableCell(value, width) {
  const text = wrapLine(value, width)[0];
  const cells = [...text].reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0 : char.codePointAt(0) > 127 ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, width - cells));
}

function formatElapsed(broadcaster, now = Date.now()) {
  const timestamp = broadcaster.live ? broadcaster.startedAt : broadcaster.lastOfflineAt;
  const started = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(started) || started > now) return "unknown";
  const seconds = Math.floor((now - started) / 1000);
  const days = Math.floor(seconds / 86400);
  const time = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
  return `${broadcaster.live ? "" : "~"}${days ? `${days}d ` : ""}${time}`;
}

function channelRow(name, stream, elapsed, online, update, chat, emotes, category = "", title = "") {
  return [tableCell(name, 20), tableCell(stream, 6), tableCell(elapsed, 15), ...[online, update, chat].map(value => tableCell(value, 7)), tableCell(emotes, 7), tableCell(category, 20), clean(title)].join(" | ");
}

const logLevels = { info: 0, warn: 1, error: 2, fatal: 3 };
const logModes = ["info", "warn", "error"];

function dashboardFrame(snapshot, recent = [], { height = 24, width = 99, now = Date.now(), logLevel = "warn", scrollOffset = 0, paused = false, unread = 0 } = {}) {
  const report = snapshot.report;
  const coverage = report?.coverage || [];
  const enabled = coverage.filter(row => row.status === "enabled").length;
  const fresh = snapshot.freshness;
  const age = (value, limit) => freshnessLabel(value, limit, now, fresh?.startedAt ?? now);
  const header = [
    "Hajimatta | r:check l:level p:pause PgUp/PgDn Home/End q:quit",
    `Updated: ${new Date().toLocaleTimeString()}  WS: ${snapshot.connection}`,
    `Subscriptions: ${report ? `${enabled}/${coverage.length}` : "checking"}  Cost: ${report?.totalCost ?? "?"}/${report?.maxTotalCost ?? "?"}  Active sessions: ${report?.enabledWebSockets ?? "?"}`,
    fresh ? `WS ${age(fresh.wsReceivedAt, fresh.wsLimitMs ?? 60000)} | STREAM ${age(fresh.streamCheckedAt, fresh.streamLimitMs ?? 250000)} | CHAT ${age(fresh.chatCheckedAt, 75000)}` : "Cost and coverage reflect the last API check; totals may lag.",
    report ? `Last API check: ${snapshot.reportAt || "-"}${fresh ? ` | SUBS ${age(fresh.diagnosticsAt, 130000)}` : ""}` : "Waiting for subscription diagnostics...",
    `Slack: pending=${snapshot.slack?.pending ?? "?"} retrying=${snapshot.slack?.retrying ?? "?"}${snapshot.slack?.stopped ? " [STOPPED]" : ""}${snapshot.slack?.lastDeliveredAt ? ` last sent ${age(snapshot.slack.lastDeliveredAt, Infinity).replace("[FRESH] ", "")} ago` : " last sent: never"}`,
    "",
    channelRow("CHANNEL", "STREAM", "ELAPSED", "ONLINE", "UPDATE", "CHAT", "EMOTES", "CATEGORY", "TITLE"),
    ...(snapshot.broadcasters || []).map(broadcaster => {
      const statuses = { enabled: "[OK]", missing: "[MISS]", other_session: "[OTHER]" };
      const events = ["stream.online", "channel.update", "channel.chat_settings.update"].map(type => {
        const row = coverage.find(row => row.broadcasterId === broadcaster.id && row.type === type);
        return row ? statuses[row.status] || "[?]" : report ? "-" : "[?]";
      });
      return channelRow(broadcaster.login, broadcaster.live ? "[LIVE]" : "[OFF]", formatElapsed(broadcaster, now), ...events,
        broadcaster.emoteMode === true ? "[EMOTE]" : broadcaster.emoteMode === false ? "[TEXT]" : "[?]",
        broadcaster.live ? broadcaster.categoryName || "-" : "",
        broadcaster.live ? broadcaster.title || "-" : "");
    }),
  ].map(line => wrapLine(line, width)[0]);
  const fixed = [...header, ""].slice(0, Math.max(0, height - 2));
  const capacity = Math.max(0, height - fixed.length - 1);
  const visible = recent.filter(entry => (logLevels[entry.level || "warn"] ?? 0) >= (logLevels[logLevel] ?? 1));
  const allRows = visible.flatMap(entry => wrapLine(typeof entry === "string" ? entry : entry.text, width));
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allRows.length - capacity)));
  const end = allRows.length - scrollOffset;
  const logs = allRows.length ? allRows.slice(Math.max(0, end - capacity), end) : ["(none)"];
  const lines = [...fixed, `LOGS: ${logLevel.toUpperCase()}+ ${paused ? `[PAUSED] new=${unread} back=${scrollOffset}` : "[FOLLOW]"} | 1/2/3:level${snapshot.logFailed ? " [FILE ERROR]" : ""}`, ...logs].slice(0, height);
  while (lines.length < height) lines.push("");
  return { lines: lines.map(line => wrapLine(line, width)[0]), scrollOffset, capacity };
}

function dashboardLines(...args) { return dashboardFrame(...args).lines; }

function colorize(line) {
  const colors = { "[LIVE]": "1;32", "[OFF]": "90", "[OK]": "32", "[MISS]": "1;31", "[OTHER]": "33", "[EMOTE]": "1;36", "[TEXT]": "90", "[info]": "36", "[warn]": "33", "[error]": "1;31", "[fatal]": "1;31" };
  Object.assign(colors, { "[FRESH]": "32", "[STALE]": "1;31", "[WAIT]": "33", "[PAUSED]": "33", "[FILE ERROR]": "1;31" });
  return line.replace(/\[(?:LIVE|OFF|OK|MISS|OTHER|EMOTE|TEXT|FRESH|STALE|WAIT|PAUSED|FILE ERROR|info|warn|error|fatal)\]/g, token => `\x1b[${colors[token]}m${token}\x1b[0m`);
}

function startDashboard(getSnapshot, { input = process.stdin, output = process.stdout, quit = () => process.exit(0), refresh = async () => {}, logLevel = "warn" } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;
  const recent = [];
  logLevel = logModes.includes(String(logLevel).toLowerCase()) ? String(logLevel).toLowerCase() : "warn";
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  let closed = false;
  let frozen = null, unread = 0, scrollOffset = 0, pageSize = 1, pendingInput = "";
  const pause = () => { if (!frozen) { frozen = recent.slice(); unread = 0; } };
  const follow = () => { frozen = null; unread = 0; scrollOffset = 0; };
  const draw = () => {
    if (closed) return;
    const height = Math.max(1, output.rows || 24);
    const width = Math.max(1, (output.columns || 100) - 1);
    const frame = dashboardFrame(getSnapshot(), frozen || recent, { height, width, logLevel, scrollOffset, paused: Boolean(frozen), unread });
    scrollOffset = frame.scrollOffset; pageSize = Math.max(1, frame.capacity);
    // Erase each previous row, including its tail, before writing shorter content.
    output.write(`\x1b[H${frame.lines.map(line => `\x1b[2K${colorize(line)}`).join("\r\n")}\x1b[J`);
  };
  const addWarning = (level, message) => {
    recent.push({ level, text: `${new Date().toLocaleTimeString()} [${level}] ${clean(message).slice(0, 16000)}` });
    if (recent.length > 1000) recent.shift();
    if (frozen) unread++;
  };
  const handleKey = key => {
    if (key === "q" || key === "\x03") { close(); quit(); return; }
    if (key === "p" || key === " ") { if (frozen) follow(); else pause(); draw(); }
    if (["up", "pageup", "home", "down", "pagedown"].includes(key)) {
      pause();
      if (key === "home") scrollOffset = Number.MAX_SAFE_INTEGER;
      else scrollOffset = Math.max(0, scrollOffset + (["up", "pageup"].includes(key) ? 1 : -1) * (key.startsWith("page") ? pageSize : 1));
      draw();
    }
    if (key === "end") { follow(); draw(); }
      if (key === "l") { logLevel = logModes[(logModes.indexOf(logLevel) + 1) % logModes.length]; draw(); }
      if (["1", "2", "3"].includes(key)) { logLevel = logModes[Number(key) - 1]; draw(); }
    if (key === "r") {
      Promise.resolve().then(refresh).catch(error => {
        addWarning("error", error.message);
        draw();
      });
    }
  };
  const sequences = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[H": "home", "\x1b[F": "end", "\x1b[1~": "home", "\x1b[4~": "end", "\x1bOH": "home", "\x1bOF": "end" };
  const onData = chunk => {
    pendingInput += String(chunk);
    while (pendingInput && !closed) {
      const match = Object.keys(sequences).find(sequence => pendingInput.startsWith(sequence));
      if (match) { pendingInput = pendingInput.slice(match.length); handleKey(sequences[match]); continue; }
      if (pendingInput.startsWith("\x1b")) {
        if (Object.keys(sequences).some(sequence => sequence.startsWith(pendingInput))) return;
        const unknown = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(pendingInput);
        if (unknown) { pendingInput = pendingInput.slice(unknown[0].length); continue; }
        if (/^\x1b\[[0-9;?]*$/.test(pendingInput)) return;
        pendingInput = pendingInput.slice(1); continue;
      }
      const key = pendingInput[0]; pendingInput = pendingInput.slice(1); handleKey(key);
    }
  };
  const onExit = () => close();
  const onInterrupt = () => { close(); process.exit(130); };
  const onTerminate = () => { close(); process.exit(143); };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    input.removeListener("data", onData);
    output.removeListener?.("resize", draw);
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
    output.write("\x1b[?25h\x1b[?1049l");
  };
  output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  output.on?.("resize", draw);
  process.once("exit", onExit);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const timer = setInterval(draw, 1000);
  timer.unref();
  draw();
  return { close, log(level, message) {
    if (Object.hasOwn(logLevels, level)) {
      addWarning(level, message);
    }
    draw();
  } };
}

module.exports = { dashboardLines, startDashboard, formatElapsed };
