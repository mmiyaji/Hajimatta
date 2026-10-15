const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileLogger, redactLog } = require("../src/file-logger");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hajimatta-logs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("all severities persist as UTF-8 JSONL and survive reopening", t => {
  const root = directory(t), now = () => Date.parse("2026-10-15T23:59:59Z");
  const logger = new FileLogger(root, { now });
  logger.write("info", "日本語\n複数行");
  new FileLogger(root, { now }).write("error", "failure");
  const lines = fs.readFileSync(path.join(root, "hajimatta-2026-10-15.log"), "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map(line => line.level), ["info", "error"]);
  assert.equal(lines[0].message, "日本語\n複数行");
});

test("size rotation keeps four backups and preserves the newest entry", t => {
  const root = directory(t);
  const logger = new FileLogger(root, { now: () => Date.parse("2026-10-15T10:00:00Z"), maxBytes: 100 });
  for (let i = 0; i < 12; i++) logger.write("info", `entry-${i}`);
  assert.equal(fs.readdirSync(root).length, 5);
  assert.match(fs.readFileSync(path.join(root, "hajimatta-2026-10-15.log"), "utf8"), /entry-11/);
  assert.ok(fs.existsSync(path.join(root, "hajimatta-2026-10-15.log.4")));
});

test("UTC date change creates a new file and retention only removes owned old logs", t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, "hajimatta-2026-10-01.log"), "old");
  fs.writeFileSync(path.join(root, "hajimatta-2026-10-02.log.1"), "keep");
  fs.writeFileSync(path.join(root, "unrelated.log"), "keep");
  let clock = Date.parse("2026-10-15T23:59:59Z");
  const logger = new FileLogger(root, { now: () => clock });
  logger.write("warn", "before");
  assert.equal(fs.existsSync(path.join(root, "hajimatta-2026-10-01.log")), false);
  assert.equal(fs.existsSync(path.join(root, "hajimatta-2026-10-02.log.1")), true);
  clock += 1000; logger.write("info", "after");
  assert.ok(fs.existsSync(path.join(root, "hajimatta-2026-10-16.log")));
  assert.equal(fs.readFileSync(path.join(root, "unrelated.log"), "utf8"), "keep");
});

test("write failures report once and logging can recover", t => {
  const root = directory(t), blocked = path.join(root, "blocked");
  fs.writeFileSync(blocked, "file");
  const errors = [];
  const logger = new FileLogger(blocked, { onError: message => errors.push(message) });
  assert.equal(logger.write("info", "first"), false);
  logger.write("error", "second");
  assert.equal(errors.length, 1);
  assert.equal(logger.failed, true);
  fs.unlinkSync(blocked);
  assert.equal(logger.write("info", "recovered"), true);
  assert.equal(logger.failed, false);
});

test("secrets, authorization headers and webhook URLs are redacted", () => {
  const text = redactLog("access-secret refresh-secret Bearer other-token https://hooks.slack.com/services/A/B/C", ["access-secret", "refresh-secret"]);
  for (const secret of ["access-secret", "refresh-secret", "other-token", "/A/B/C"]) assert.equal(text.includes(secret), false);
});
