const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("cost exhaustion preserves successful subscriptions and retries only missing events", async () => {
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  const timers = [];
  const calls = [];
  let full = true;
  const context = vm.createContext({
    async diagnoseSubscriptions() {},
    log() {}, clearTimeout() {},
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    async createSubscription(type, id) {
      calls.push(`${type}:${id}`);
      if (full && type === "stream.online") {
        const error = new Error("cost exceeded"); error.status = 429; throw error;
      }
    },
  });
  vm.runInContext(`
    const SUBSCRIPTION_TYPES = ["stream.online", "channel.update"];
    const CHAT_SETTINGS_TYPE = "channel.chat_settings.update";
    const chatUserId = "user";
    const resolvedBroadcasters = [{ id: "1" }, { id: "2" }];
    const websocket = {}; let eventsubReady = false;
    ${source.slice(source.indexOf("async function registerSubscriptions("), source.indexOf("async function cleanupManagedSubscriptions("))}
  `, context);
  await vm.runInContext('registerSubscriptions("session")', context);
  assert.equal(vm.runInContext("websocket.registeredSubscriptions.size", context), 4);
  assert.equal(vm.runInContext("eventsubReady", context), true);
  assert.equal(timers[0].ms, 60000);
  assert.deepEqual(calls.slice(0, 2), ["channel.chat_settings.update:1", "channel.chat_settings.update:2"]);
  calls.length = 0; full = false;
  await vm.runInContext('registerSubscriptions("session")', context);
  assert.deepEqual(calls, ["stream.online:1", "stream.online:2"]);
  assert.equal(vm.runInContext("websocket.registeredSubscriptions.size", context), 6);
});
