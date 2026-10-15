const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("startup preserves an observed end but does not invent one for a missed transition", async () => {
  const source = fs.readFileSync(require.resolve("../src/index.js"), "utf8");
  const ended = "2026-10-14T10:00:00Z";
  for (const live of [false, true]) {
    const broadcaster = { id: "1", login: "channel", live, lastOfflineAt: ended };
    const state = { broadcasters: { "1": broadcaster } };
    const context = vm.createContext({ state, stateFile: "unused", resolvedBroadcasters: [{ id: "1", login: "channel" }],
      freshness: {},
      fetchLiveStreamsByLogin: async () => [], fetchChannelInformationById: async () => [], saveState() {}, log() {},
    });
    vm.runInContext(source.slice(source.indexOf("async function hydrateInitialState("), source.indexOf("function startLiveReconcileLoop(")), context);
    await vm.runInContext("hydrateInitialState()", context);
    assert.equal(broadcaster.live, false);
    assert.equal(broadcaster.lastOfflineAt, live ? null : ended);
  }
});
