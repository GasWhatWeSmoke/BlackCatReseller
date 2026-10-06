import test from "node:test";
import assert from "node:assert/strict";
import { saleCheckMinutes, validSaleCheckMinutes, validSaleChecksPerDay } from "./saleMonitorSettings.ts";

test("frequency accepts whole minutes from two minutes to a day and rejects malformed settings", () => {
  for (const value of [2, 5, 60, 1440]) { assert.equal(validSaleCheckMinutes(value), true); assert.equal(saleCheckMinutes(value), value); }
  for (const value of [undefined, null, "5", false, 0, -1, 1, 1.5, 1441, Infinity, NaN]) {
    assert.equal(validSaleCheckMinutes(value), false);
    assert.equal(saleCheckMinutes(value), 2);
  }
});

test("daily targets retain precise spacing and respect the existing two-minute minimum", () => {
  for (const count of [1, 4, 7, 24, 600, 720]) {
    assert.equal(validSaleChecksPerDay(count), true);
    assert.equal(saleCheckMinutes(60, count), 1440 / count);
  }
  assert.equal(saleCheckMinutes(60, 4), 360);
  assert.equal(saleCheckMinutes(60, 720), 2);
});

test("missing or malformed daily targets preserve the saved minute schedule", () => {
  for (const count of [undefined, null, "4", false, 0, -1, 1.5, 721, Infinity, NaN]) {
    assert.equal(validSaleChecksPerDay(count), false);
    assert.equal(saleCheckMinutes(60, count), 60);
  }
  assert.equal(saleCheckMinutes(undefined, null), 2);
});
