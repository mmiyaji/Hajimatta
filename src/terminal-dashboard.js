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

function channelRow(name, stream, online, update, chat, category = "", title = "") {
  return [tableCell(name, 20), tableCell(stream, 6), ...[online, update, chat].map(value => tableCell(value, 7)), tableCell(category, 20), clean(title)].join(" | ");
}

function dashboardLines(snapshot, recent = [], { height = 24, width = 99 } = {}) {
  const report = snapshot.report;
  const coverage = report?.coverage || [];
  const enabled = coverage.filter(row => row.status === "enabled").length;
  const header = [
    "Hajimatta | Twitch EventSub monitor | r: refresh | q: quit",
    `Updated: ${new Date().toLocaleTimeString()}  WS: ${snapshot.connection}`,
    `Subscriptions: ${report ? `${enabled}/${coverage.length}` : "checking"}  Cost: ${report?.totalCost ?? "?"}/${report?.maxTotalCost ?? "?"}  Active sessions: ${report?.enabledWebSockets ?? "?"}`,
    "Cost and coverage reflect the last API check; totals may lag.",
    report ? `Last API check: ${snapshot.reportAt || "-"}` : "Waiting for subscription diagnostics...",
    `Slack: pending=${snapshot.slack?.pending ?? "?"} retrying=${snapshot.slack?.retrying ?? "?"}${snapshot.slack?.stopped ? " [STOPPED]" : ""}`,
    "",
    channelRow("CHANNEL", "STREAM", "ONLINE", "UPDATE", "CHAT", "CATEGORY", "TITLE"),
    ...(snapshot.broadcasters || []).map(broadcaster => {
      const statuses = { enabled: "[OK]", missing: "[MISS]", other_session: "[OTHER]" };
      const events = ["stream.online", "channel.update", "channel.chat_settings.update"].map(type => {
        const row = coverage.find(row => row.broadcasterId === broadcaster.id && row.type === type);
        return row ? statuses[row.status] || "[?]" : report ? "-" : "[?]";
      });
      return channelRow(broadcaster.login, broadcaster.live ? "[LIVE]" : "[OFF]", ...events,
        broadcaster.live ? broadcaster.categoryName || "-" : "",
        broadcaster.live ? broadcaster.title || "-" : "");
    }),
  ].map(line => wrapLine(line, width)[0]);
  const fixed = [...header, ""].slice(0, Math.max(0, height - 2));
  const capacity = Math.max(0, height - fixed.length - 1);
  const logs = recent.length ? recent.flatMap(line => wrapLine(line, width)).slice(-capacity) : ["(none)"];
  const lines = [...fixed, "RECENT WARNINGS / ERRORS (newest at bottom)", ...logs].slice(0, height);
  while (lines.length < height) lines.push("");
  return lines.map(line => wrapLine(line, width)[0]);
}

function colorize(line) {
  const colors = { "[LIVE]": "1;32", "[OFF]": "90", "[OK]": "32", "[MISS]": "1;31", "[OTHER]": "33", "[warn]": "33", "[error]": "1;31", "[fatal]": "1;31" };
  return line.replace(/\[(?:LIVE|OFF|OK|MISS|OTHER|warn|error|fatal)\]/g, token => `\x1b[${colors[token]}m${token}\x1b[0m`);
}

function startDashboard(getSnapshot, { input = process.stdin, output = process.stdout, quit = () => process.exit(0), refresh = async () => {} } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;
  const recent = [];
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  let closed = false;
  const draw = () => {
    if (closed) return;
    const height = Math.max(1, output.rows || 24);
    const width = Math.max(1, (output.columns || 100) - 1);
    const lines = dashboardLines(getSnapshot(), recent, { height, width });
    // Erase each previous row, including its tail, before writing shorter content.
    output.write(`\x1b[H${lines.map(line => `\x1b[2K${colorize(line)}`).join("\r\n")}\x1b[J`);
  };
  const addWarning = (level, message) => {
    recent.push(`${new Date().toLocaleTimeString()} [${level}] ${clean(message).slice(0, 16000)}`);
    if (recent.length > 1000) recent.shift();
  };
  const onData = chunk => {
    if (String(chunk).includes("q") || String(chunk).includes("\x03")) { close(); quit(); return; }
    if (String(chunk).includes("r")) {
      Promise.resolve().then(refresh).catch(error => {
        addWarning("error", error.message);
        draw();
      });
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
    if (["warn", "error", "fatal"].includes(level)) {
      addWarning(level, message);
    }
    draw();
  } };
}

module.exports = { dashboardLines, startDashboard };
