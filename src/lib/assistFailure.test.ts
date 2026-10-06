// The auto-run circuit breaker stops for NIFTY being broken, not for items with their own
// missing details — and stops at once when a person is needed in the Nifty window.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAssistFailure, breakerAfterFailure, breakerMessage, BREAKER_START,
} from "./assistFailure.ts";

test("a missing-field failure is an item problem, not a broken Nifty", () => {
  // The exact reasons the 2026-09-05 run produced.
  for (const e of [
    "finalize-incomplete: Nifty still needs Style [ebay]",
    "finalize-incomplete: Nifty still needs Category [poshmark], Type [ebay]",
    "finalize-incomplete",
    "price-required",
    "ebay-shipping-over-weight-limit",
    "photo-upload-incomplete: only 3/5 photos made it onto the listing",
  ]) assert.equal(classifyAssistFailure(e), "item", e);
});

test("a run that never reaches the form is systemic", () => {
  for (const e of [
    "form-not-ready",
    "no-finalize-button",
    "off-nifty — the window ended on www.google.com; re-run this item (nothing was posted)",
    "timed out before finishing (worker stopped)",
    "the Nifty window was closed mid-run — item NOT posted; just re-run it",
    "the Nifty browser profile is in use — close any open assist window, then Retry failed",
    "Could not start the worker: spawn python ENOENT",
  ]) assert.equal(classifyAssistFailure(e), "systemic", e);
});

test("a security check or a dead login needs a person", () => {
  assert.equal(classifyAssistFailure("security-check — complete the check in the Nifty window, then Retry failed (nothing was posted)"), "human");
  assert.equal(classifyAssistFailure("logged-out — log in to Nifty again (Ready page → open Nifty to log in), then Retry failed"), "human");
  assert.equal(classifyAssistFailure(undefined), "item");
});

test("item failures get three times the allowance; systemic ones the setting itself", () => {
  let s = BREAKER_START;
  for (let i = 1; i <= 14; i++) {
    const r = breakerAfterFailure(s, "item", 5);
    s = r.state;
    assert.equal(r.trip, null, `item failure #${i} must not trip`);
  }
  assert.equal(breakerAfterFailure(s, "item", 5).trip, "items");

  s = BREAKER_START;
  for (let i = 1; i <= 4; i++) s = breakerAfterFailure(s, "systemic", 5).state;
  assert.equal(breakerAfterFailure(s, "systemic", 5).trip, "systemic");
});

test("the two counters are independent and the breaker can be off", () => {
  let s = BREAKER_START;
  s = breakerAfterFailure(s, "item", 5).state;
  s = breakerAfterFailure(s, "systemic", 5).state;
  assert.deepEqual(s, { systemic: 1, item: 1 });
  for (let i = 0; i < 40; i++) assert.equal(breakerAfterFailure(s, "systemic", 0).trip, null);
});

test("a human-needed failure trips at once, even with the breaker off", () => {
  assert.equal(breakerAfterFailure(BREAKER_START, "human", 0).trip, "human");
  assert.equal(breakerAfterFailure(BREAKER_START, "human", 5).trip, "human");
});

test("each stop has its own explanation", () => {
  assert.match(breakerMessage("human", BREAKER_START), /Nifty window is asking for a person/);
  assert.match(breakerMessage("systemic", { systemic: 5, item: 0 }), /5 uploads in a row never reached/);
  assert.match(breakerMessage("items", { systemic: 0, item: 15 }), /15 items in a row failed on their own listing details/);
});
