// Depop adapter pure logic (§45.14): validation limits + the worker protocol
// parser. The field BUILDING is Python-side and tested in
// worker/tests/test_depop_logic.py — these are the Node-side halves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEPOP_MAX_PHOTOS, depopValidate, depopPublicationError, parseDepopDone } from "./mapping.ts";
import { confirmDepopLogin, depopLoginAwaitingConfirmation } from "./index.ts";
import type { CanonicalListing } from "../../types.ts";
import type { AppSettingsData } from "../../../types.ts";

test("only an explicit unsent address-service outage can retry automatically", () => {
  const reason = "Depop saved shipping addresses are temporarily unavailable";
  const report = { outcome: "failed" as const, submissionStarted: false, reason };
  assert.equal(depopPublicationError(report).errorClass, "retryable");
  assert.equal(depopPublicationError(report).notSubmitted, true);
  for (const changed of [
    { ...report, submissionStarted: true },
    { ...report, submissionStarted: undefined },
    { ...report, outcome: "posted" as const },
    { ...report, url: "https://www.depop.com/products/example-item/" },
    { ...report, reason: "Choose one saved shipping address in Depop before posting" },
  ]) assert.equal(depopPublicationError(changed).errorClass, "requires_review");
});

const listing = (over: Partial<CanonicalListing> = {}): CanonicalListing => ({
  itemId: 1, sku: "000084",
  title: "NWT Ed Hardy Womens Colorblock Tattoo-print Shoulder Bag Pink Graphic Print",
  description: "Bold tattoo-print shoulder bag.",
  price: 49.99, condition: "New with tags",
  brand: "Ed Hardy", size: null, itemType: "Shoulder Bag", category: "Bags",
  categoryGroup: "Bag", department: "Women", material: null, style: "Y2K",
  color: "Pink", secondaryColor: null, pattern: "Graphic", fit: null,
  model: null, styleNumber: null, countryOfOrigin: null, inseam: null,
  weightOz: 16, packageDims: { length: 14, width: 12, height: 6 },
  photos: [{ path: "C:/x/000084_01.jpg", name: "000084_01.jpg" }],
  quantity: 1,
  ...over,
});

test("a clean listing passes Depop validation", () => {
  assert.deepEqual(depopValidate(listing()), []);
});

test("multiple units cannot silently become a one-unit Depop listing", () => {
  assert.ok(depopValidate(listing({ quantity: 2 })).some((issue) => issue.field === "quantity"));
});

test("no photos, sub-$1 price, and unmapped conditions each block before a browser opens", () => {
  assert.ok(depopValidate(listing({ photos: [] })).some((i) => i.field === "photos"));
  assert.ok(depopValidate(listing({ price: 0.5 })).some((i) => i.field === "price"));
  assert.ok(depopValidate(listing({ condition: "Salvage" })).some((i) => i.field === "condition"));
});

test("more photos than Depop's limit is NOT a validation failure — the worker posts the first 8 and says so", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ path: `C:/x/p${i}.jpg`, name: `000084_${i + 1}.jpg` }));
  assert.deepEqual(depopValidate(listing({ photos: many })), []);
  assert.equal(DEPOP_MAX_PHOTOS, 8);
});

test("the protocol parser reads the LAST report and ignores progress noise", () => {
  const buf = [
    "[depop] 000084: opening the sell form",
    'DEPOP_DONE {"outcome":"failed","reason":"first attempt"}',
    "[depop] 000084: posting",
    'DEPOP_DONE {"outcome":"posted","url":"https://www.depop.com/products/blackcat-bag/"}',
  ].join("\n");
  const done = parseDepopDone(buf);
  assert.equal(done?.outcome, "posted");
  assert.equal(done?.url, "https://www.depop.com/products/blackcat-bag/");
});

test("garbage, absent, or unknown-outcome reports parse to null, never a fake success", () => {
  assert.equal(parseDepopDone("no report at all"), null);
  assert.equal(parseDepopDone("DEPOP_DONE not-json"), null);
  assert.equal(parseDepopDone('DEPOP_DONE {"outcome":"maybe"}'), null);
});

test("a timeout or lost Depop report is ambiguous unless the worker proves submission never started", () => {
  for (const done of [null, { outcome: "failed" as const, reason: "network timeout" },
    { outcome: "failed" as const, reason: "network timeout", submissionStarted: true },
    { outcome: "filled" as const, submissionStarted: false }]) {
    const error = depopPublicationError(done);
    assert.equal(error.notSubmitted, false);
    assert.equal(error.errorClass, "requires_review");
  }
  const safe = depopPublicationError({ outcome: "failed", reason: "network timeout", submissionStarted: false });
  assert.equal(safe.notSubmitted, true);
  assert.equal(safe.errorClass, "retryable");
});

test("manual Depop login cannot be confirmed until its browser-close handoff exists", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-depop-login-"));
  const settings = { dataRoot } as AppSettingsData;
  try {
    assert.equal(depopLoginAwaitingConfirmation(settings), false);
    assert.equal(confirmDepopLogin(settings).ok, false);

    fs.writeFileSync(path.join(dataRoot, "depop-login-pending.json"), "{}", "utf8");
    assert.equal(depopLoginAwaitingConfirmation(settings), true);
    assert.equal(confirmDepopLogin(settings).ok, true);
    assert.equal(fs.existsSync(path.join(dataRoot, "depop-login-pending.json")), false);
    assert.equal(fs.existsSync(path.join(dataRoot, "depop-login-ok.json")), true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
