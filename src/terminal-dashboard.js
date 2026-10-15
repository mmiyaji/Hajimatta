function clean(value) {
  return String(value ?? "-").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function dashboardLines(snapshot, recent = []) {
  const report = snapshot.report;
  const coverage = report?.coverage || [];
  const enabled = coverage.filter(row => row.status === "enabled").length;
  return [
    "Hajimatta | Twitch EventSub monitor | r: refresh | q: quit",
    `Updated: ${new Date().toLocaleTimeString()}  WS: ${snapshot.connection}`,
    `Subscriptions: ${report ? `${enabled}/${coverage.length}` : "checking"}  Cost: ${report?.totalCost ?? "?"}/${report?.maxTotalCost ?? "?"}  Active sessions: ${report?.enabledWebSockets ?? "?"}`,
    "Cost and coverage reflect the last API check; totals may lag.",
    report ? `Last API check: ${snapshot.reportAt || "-"}` : "Waiting for subscription diagnostics...",
    "",
    "CHANNEL | STREAM | EVENT SUBSCRIPTIONS",
    ...(snapshot.broadcasters || []).map(broadcaster => {
      const labels = { "stream.online": "online", "channel.update": "update", "channel.chat_settings.update": "chat" };
      const events = coverage.filter(row => row.broadcasterId === broadcaster.id)
        .map(row => `${labels[row.type] || row.type}=${row.status}`).join(" / ");
      return `${broadcaster.login} | ${broadcaster.live ? "LIVE" : "offline"} | ${events || "checking"}`;
    }),
    "",
    "RECENT WARNINGS / ERRORS",
    ...(recent.length ? recent.slice(-5) : ["(none)"]),
  ].map(clean);
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
    const lines = dashboardLines(getSnapshot(), recent).slice(0, height).map(line => {
      // Count non-ASCII characters conservatively as two terminal cells.
      let cells = 0, result = "";
      for (const char of line) {
        cells += char.codePointAt(0) > 127 ? 2 : 1;
        if (cells > width) break;
        result += char;
      }
      return result;
    });
    output.write(`\x1b[H${lines.join("\n")}\x1b[J`);
  };
  const onData = chunk => {
    if (String(chunk).includes("q") || String(chunk).includes("\x03")) { close(); quit(); return; }
    if (String(chunk).includes("r")) {
      Promise.resolve().then(refresh).catch(error => {
        recent.push(`[error] ${error.message}`);
        if (recent.length > 5) recent.shift();
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
  process.once("exit", onExit);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const timer = setInterval(draw, 1000);
  timer.unref();
  draw();
  return { close, log(level, message) {
    if (["warn", "error", "fatal"].includes(level)) {
      recent.push(`${new Date().toLocaleTimeString()} [${level}] ${message}`);
      if (recent.length > 5) recent.shift();
    }
    draw();
  } };
}

module.exports = { dashboardLines, startDashboard };
