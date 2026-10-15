const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { acquireInstanceGuard, defaultPort } = require("../src/instance-guard");

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test("rejects concurrent instances and allows restart after release", async () => {
  const port = await unusedPort();
  const first = await acquireInstanceGuard("app", port);
  try { await assert.rejects(acquireInstanceGuard("app", port), /startup stopped/); }
  finally { await first.close(); }
  const second = await acquireInstanceGuard("app", port); await second.close();
});

test("OS releases guard after process termination", async () => {
  const port = await unusedPort();
  const modulePath = require.resolve("../src/instance-guard");
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(modulePath)}).acquireInstanceGuard('app', ${port}).then(() => { console.log('ready'); setInterval(() => {}, 1000); });`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("child exited before acquiring guard"); })]);
    await assert.rejects(acquireInstanceGuard("app", port), /startup stopped/);
    const exited = once(child, "exit"); child.kill(); await exited;
    const replacement = await acquireInstanceGuard("app", port); await replacement.close();
  } finally { if (child.exitCode === null) child.kill(); }
});

test("deterministic client port and invalid overrides", async () => {
  assert.equal(defaultPort("app"), defaultPort("app"));
  for (const port of [0, 1023, 65536, "abc", 1.5]) await assert.rejects(acquireInstanceGuard("app", port), /TWITCH_INSTANCE_PORT/);
});
