const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshnessLabel } = require("../src/freshness");

test("freshness ages independently and becomes stale at its deadline", () => {
  assert.equal(freshnessLabel(100000, 60000, 105000), "[FRESH] 5s");
  assert.equal(freshnessLabel(100000, 60000, 161000), "[STALE] 1m");
  assert.equal(freshnessLabel(100000, 250000, 161000), "[FRESH] 1m");
});
test("a missing first sample stops appearing healthy after startup grace", () => {
  assert.equal(freshnessLabel(undefined, 60000, 100000, 100000), "[WAIT]");
  assert.equal(freshnessLabel(undefined, 60000, 161000, 100000), "[STALE] never");
});
