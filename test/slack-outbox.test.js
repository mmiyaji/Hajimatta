const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SlackOutbox, sendSlackWebhook } = require("../src/slack-outbox");

function fixture(t, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hajimatta-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100000;
  const options = { send, now: () => time, setTimer: () => 1, clearTimer() {} };
  const file = path.join(dir, "queue.json");
  const queue = new SlackOutbox(file, options);
  return { queue, file, options, advance: ms => { time += ms; } };
}

test("enqueued payload survives restart and is removed only after delivery", async t => {
  const sent = [];
  const f = fixture(t, async payload => sent.push(payload));
  const payload = { text: "stream started" };
  f.queue.enqueue(payload); payload.text = "mutated";
  assert.equal(JSON.parse(fs.readFileSync(f.file)).items[0].payload.text, "stream started");
  const restarted = new SlackOutbox(f.file, f.options);
  restarted.start(); await restarted.flush(); await restarted.close();
  assert.deepEqual(sent, [{ text: "stream started" }]);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).items.length, 0);
});

test("network failures back off across restart and respect Retry-After", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; const error = new Error("network"); error.status = 429; error.retryAfterMs = 120000; throw error; });
  f.queue.enqueue({ text: "retry" }); f.queue.start(); await f.queue.flush();
  assert.equal(f.queue.data.items[0].attempts, 1);
  assert.equal(f.queue.data.items[0].nextAttemptAt, 220000);
  await f.queue.close();
  const restarted = new SlackOutbox(f.file, f.options); restarted.start();
  await restarted.flush(); assert.equal(calls, 1);
  f.advance(120000); await restarted.flush(); assert.equal(calls, 2);
  await restarted.close();
});

test("a malformed payload is retained without blocking later notifications", async t => {
  const sent = [];
  const f = fixture(t, async payload => {
    if (payload.text === "bad") { const e = new Error("bad"); e.status = 400; throw e; }
    sent.push(payload.text);
  });
  f.queue.enqueue({ text: "bad" }); f.queue.enqueue({ text: "good" });
  f.queue.start(); await f.queue.flush(); f.advance(1000); await f.queue.flush();
  assert.deepEqual(sent, ["good"]);
  assert.equal(f.queue.data.items.length, 1);
  assert.equal(f.queue.data.items[0].nextAttemptAt, 3700000);
  await f.queue.close();
});

test("only one send runs and enqueues during a request are preserved", async t => {
  let finish, calls = 0;
  const f = fixture(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  f.queue.enqueue({ text: "first" }); f.queue.start();
  const first = f.queue.flush(); const duplicate = f.queue.flush();
  f.queue.enqueue({ text: "second" });
  assert.equal(calls, 1); finish(); await Promise.all([first, duplicate]);
  assert.deepEqual(f.queue.data.items.map(item => item.payload.text), ["second"]);
  await f.queue.close();
});

test("corrupt queue fails closed without overwriting notifications", t => {
  const f = fixture(t, async () => {});
  fs.writeFileSync(f.file, "corrupt");
  assert.throws(() => new SlackOutbox(f.file, f.options));
  assert.equal(fs.readFileSync(f.file, "utf8"), "corrupt");
});

test("webhook sends use a timeout and redact URL/body from errors", async () => {
  await assert.rejects(sendSlackWebhook("secret-url", {}, async (url, options) => {
    assert.ok(options.signal); throw new Error(url);
  }), error => !error.message.includes("secret-url"));
  await assert.rejects(sendSlackWebhook("secret-url", {}, async () => ({ ok: false, status: 429,
    headers: { get: () => "30" }, text: async () => "sensitive-response" })), error => error.status === 429 && error.retryAfterMs === 30000 && !error.message.includes("sensitive-response"));
});

test("disk write failure rejects enqueue instead of claiming it was saved", t => {
  const f = fixture(t, async () => {});
  fs.mkdirSync(f.file);
  assert.throws(() => f.queue.enqueue({ text: "must persist" }));
  assert.equal(f.queue.data.items.length, 0);
});

test("429 pauses the entire webhook queue including after restart", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; const e = new Error("rate limited"); e.status = 429; e.retryAfterMs = 60000; throw e; });
  f.queue.enqueue({ text: "first" }); f.queue.enqueue({ text: "second" });
  f.queue.start(); await f.queue.flush(); await f.queue.close();
  const restarted = new SlackOutbox(f.file, f.options); restarted.start();
  f.advance(1000); await restarted.flush(); assert.equal(calls, 1);
  f.advance(59000); await restarted.flush(); assert.equal(calls, 2);
  await restarted.close();
});

test("a transient failure retries after the delay and drains successfully", async t => {
  let calls = 0;
  const f = fixture(t, async () => { if (++calls === 1) throw new Error("offline"); });
  f.queue.enqueue({ text: "event" }); f.queue.start(); await f.queue.flush();
  assert.equal(f.queue.status().retrying, 1);
  f.advance(4999); await f.queue.flush(); assert.equal(calls, 1);
  f.advance(1); await f.queue.flush();
  assert.equal(calls, 2);
  assert.equal(f.queue.status().pending, 0);
  await f.queue.close();
});
