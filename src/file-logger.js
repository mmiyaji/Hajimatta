const fs = require("node:fs");
const path = require("node:path");

function redactLog(message, secrets = []) {
  let text = String(message);
  for (const secret of secrets.filter(value => typeof value === "string" && value.length > 3).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[^\s"'<>]+/g, "[SLACK_WEBHOOK]")
    .replace(/\b(Bearer|OAuth)\s+[a-zA-Z0-9._~-]+/g, "$1 [REDACTED]");
}

class FileLogger {
  constructor(directory, { now = Date.now, maxBytes = 5 * 1024 * 1024, retentionDays = 14, onError = () => {} } = {}) {
    this.directory = path.resolve(directory); this.now = now; this.maxBytes = maxBytes;
    this.retentionDays = retentionDays; this.onError = onError; this.failed = false;
    if (!Number.isFinite(maxBytes) || maxBytes < 1 || !Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Invalid file log limits");
  }
  write(level, message) {
    try {
      const timestamp = new Date(this.now()).toISOString();
      const day = timestamp.slice(0, 10);
      fs.mkdirSync(this.directory, { recursive: true });
      if (this.cleanedDay !== day) {
        const cutoff = Date.parse(`${day}T00:00:00Z`) - (this.retentionDays - 1) * 86400000;
        for (const name of fs.readdirSync(this.directory)) {
          const match = /^hajimatta-(\d{4}-\d{2}-\d{2})\.log(?:\.[1-4])?$/.exec(name);
          if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(this.directory, name));
        }
        this.cleanedDay = day;
      }
      const file = path.join(this.directory, `hajimatta-${day}.log`);
      const line = JSON.stringify({ timestamp, level, message: String(message).slice(0, 64000) }) + "\n";
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.maxBytes) {
        if (fs.existsSync(`${file}.4`)) fs.unlinkSync(`${file}.4`);
        for (let i = 3; i >= 0; i--) {
          const source = i ? `${file}.${i}` : file;
          if (fs.existsSync(source)) fs.renameSync(source, `${file}.${i + 1}`);
        }
      }
      fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      this.failed = false;
      return true;
    } catch {
      if (!this.failed) this.onError("File logging failed; check disk space and log directory permissions");
      this.failed = true; return false;
    }
  }
}

module.exports = { FileLogger, redactLog };
