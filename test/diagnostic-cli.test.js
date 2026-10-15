const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");

test("diagnostic CLI only reads API state, without Slack, websocket, files or instance guard", async () => {
  const filename = require.resolve("../src/index.js");
  const localRequire = createRequire(filename);
  const calls = [], logs = [];
  const fakeProcess = { argv: ["node", "index.js", "--diagnose"], cwd: () => process.cwd(), env: {
    TWITCH_CLIENT_ID: "test-client", TWITCH_ACCESS_TOKEN: "test-token", TWITCH_BROADCASTERS: "channel",
  } };
  const context = vm.createContext({ process: fakeProcess, AbortSignal, URL,
    console: { log: line => logs.push(line), error: line => logs.push(line) },
    require(name) {
      if (name === "node:fs") return { existsSync: () => false };
      if (name === "ws") return class { constructor() { throw new Error("Unexpected websocket"); } };
      if (name === "./instance-guard") return { acquireInstanceGuard() { throw new Error("Unexpected lock"); } };
      return localRequire(name);
    },
    async fetch(url, options = {}) {
      calls.push({ url, method: options.method || "GET" });
      let body;
      if (url.endsWith("/validate")) body = { client_id: "test-client", user_id: "user", login: "user", scopes: [] };
      else if (url.includes("/users?")) body = { data: [{ id: "1", login: "channel", display_name: "channel" }] };
      else if (url.includes("/eventsub/subscriptions")) body = { data: [], total: 0, total_cost: 0, max_total_cost: 10 };
      else throw new Error(`Unexpected request ${url}`);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const source = fs.readFileSync(filename, "utf8").replace("main().catch(", "globalThis.completion = main().catch(");
  vm.runInContext(source, context);
  await context.completion;
  assert.equal(fakeProcess.exitCode, undefined, logs.join("\n"));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === "GET"));
  assert.ok(logs.some(line => line.includes("cost=0/10")));
});
