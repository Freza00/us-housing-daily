import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEffectiveWindow } from "../lib/digest-core.mjs";

test("selectEffectiveWindow: pool >= 60 keeps 24h", () => {
  const r = selectEffectiveWindow({ pool24: 135, pool48: 200, pool72: 240 });
  assert.equal(r.hours, 24);
  assert.equal(r.pool_sizes["24h"], 135);
});

test("selectEffectiveWindow: pool < 60 expands to 48h", () => {
  const r = selectEffectiveWindow({ pool24: 38, pool48: 91, pool72: 142 });
  assert.equal(r.hours, 48);
});

test("selectEffectiveWindow: pool48 < 30 expands to 72h", () => {
  const r = selectEffectiveWindow({ pool24: 12, pool48: 22, pool72: 47 });
  assert.equal(r.hours, 72);
});

test("selectEffectiveWindow: still picks 72h even if pool72 also tiny", () => {
  const r = selectEffectiveWindow({ pool24: 5, pool48: 9, pool72: 18 });
  assert.equal(r.hours, 72);
});

test("selectEffectiveWindow: pool24=60 stays 24h (boundary)", () => {
  assert.equal(selectEffectiveWindow({ pool24: 60, pool48: 90, pool72: 130 }).hours, 24);
});

test("selectEffectiveWindow: pool24=59 expands to 48h (boundary)", () => {
  assert.equal(selectEffectiveWindow({ pool24: 59, pool48: 90, pool72: 130 }).hours, 48);
});

test("selectEffectiveWindow: pool48=30 stays 48h (boundary)", () => {
  assert.equal(selectEffectiveWindow({ pool24: 20, pool48: 30, pool72: 60 }).hours, 48);
});

test("selectEffectiveWindow: pool48=29 expands to 72h (boundary)", () => {
  assert.equal(selectEffectiveWindow({ pool24: 20, pool48: 29, pool72: 60 }).hours, 72);
});
