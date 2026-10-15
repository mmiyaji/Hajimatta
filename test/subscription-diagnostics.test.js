const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listSubscriptions, summarizeSubscriptions } = require("../src/subscription-diagnostics");
const fs = require("node:fs");
const vm = require("node:vm");

test("reads all pages and retains API cost totals", async () => {
  const urls = [];
  const pages = [
    { data: [{ id: "a" }], total: 2, total_cost: 10, max_total_cost: 10, pagination: { cursor: "next/page" } },
    { data: [{ id: "b" }], pagination: {} },
  ];
  const snapshot = await listSubscriptions(async url => {
    urls.push(new URL(url)); return { ok: true, json: async () => pages.shift() };
  });
  assert.equal(snapshot.data.length, 2);
  assert.equal(snapshot.totalCost, 10);
  assert.equal(snapshot.maxTotalCost, 10);
  assert.equal(urls[1].searchParams.get("after"), "next/page");
});

test("reports enabled, other-session and missing without leaking transport secrets", () => {
  const row = (type, status, session) => ({ id: type, type, version: "1", cost: 1, status,
    condition: { broadcaster_user_id: "1" }, transport: { method: "websocket", session_id: session, secret: "secret" } });
  const report = summarizeSubscriptions({ total: 3, totalCost: 10, maxTotalCost: 10, data: [
    row("stream.online", "enabled", "current"), row("channel.update", "enabled", "elsewhere"),
    row("channel.chat_settings.update", "authorization_revoked", "current"),
  ] }, [{ id: "1", login: "channel" }], ["stream.online", "channel.update", "channel.chat_settings.update"], "current", "user");
  assert.deepEqual(report.coverage.map(row => row.status), ["enabled", "other_session", "missing"]);
  assert.equal(report.enabledWebSockets, 2);
  assert.equal(JSON.stringify(report).includes("secret"), false);
});

test("diagnostic-only coverage accepts existing sessions but verifies the chat user", () => {
  const report = summarizeSubscriptions({ data: [{ type: "channel.chat_settings.update", version: "1", status: "enabled",
    condition: { broadcaster_user_id: "1", user_id: "other" }, transport: { method: "websocket", session_id: "a" } }] },
  [{ id: "1" }], ["channel.chat_settings.update"], null, "user");
  assert.equal(report.coverage[0].status, "missing");
});

test("HTTP and repeating pagination failures are explicit", async () => {
  await assert.rejects(listSubscriptions(async () => ({ ok: false, status: 401 })), /HTTP 401/);
  await assert.rejects(listSubscriptions(async () => ({ ok: true, json: async () => ({ data: [], pagination: { cursor: "same" } }) })), /repeated/);
});

test("a 409 is successful only when the subscription belongs to this session", async () => {
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  for (const owner of ["current", "other"]) {
    const context = vm.createContext({
      log() {}, twitchHeaders: () => ({}), subscriptionListRequest() {},
      twitchFetch: async () => ({ status: 409 }),
      listSubscriptions: async () => ({ data: [{ type: "stream.online", version: "1", status: "enabled",
        condition: { broadcaster_user_id: "1" }, transport: { method: "websocket", session_id: owner } }] }),
    });
    vm.runInContext(`const TWITCH_API_BASE_URL = "https://example.invalid";
      const CHAT_SETTINGS_TYPE = "channel.chat_settings.update";
      const chatUserId = "user";
      ${source.slice(source.indexOf("async function createSubscription("), source.indexOf("async function reconnectTo("))}
    `, context);
    const result = vm.runInContext('createSubscription("stream.online", "1", "current")', context);
    if (owner === "current") await result;
    else await assert.rejects(result, error => error.status === 429 && /conflict/.test(error.message));
  }
});

test("startup cleanup preserves enabled subscriptions on other sessions", async () => {
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  const deleted = [];
  const row = (id, status) => ({ id, status, type: "stream.online", condition: { broadcaster_user_id: "1" },
    transport: { method: "websocket", session_id: "other" } });
  const context = vm.createContext({
    log() {}, twitchHeaders: () => ({}), subscriptionListRequest() {},
    listSubscriptions: async () => ({ data: [row("active", "enabled"), row("old", "websocket_disconnected")] }),
    twitchFetch: async url => { deleted.push(url); return { ok: true }; },
  });
  vm.runInContext(`const TWITCH_API_BASE_URL = "https://example.invalid";
    const SUBSCRIPTION_TYPES = ["stream.online", "channel.update"];
    const CHAT_SETTINGS_TYPE = "channel.chat_settings.update";
    const resolvedBroadcasters = [{ id: "1" }];
    ${source.slice(source.indexOf("async function cleanupManagedSubscriptions("), source.indexOf("function subscriptionListRequest("))}
  `, context);
  await vm.runInContext("cleanupManagedSubscriptions()", context);
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].endsWith("id=old"));
});
