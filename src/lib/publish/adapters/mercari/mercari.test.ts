import test from "node:test";
import assert from "node:assert/strict";
import { mercariValidate, mercariPublicationError } from "./mapping.ts";
import type { CanonicalListing } from "../../types.ts";
import type { AppSettingsData } from "../../../types.ts";
import { listingIdentity } from "../../attempts.ts";
import { parseBrowserReport } from "../../browserProtocol.ts";

const listing = { title: "Reviewed shirt", description: "Reviewed description.", brand: "Gildan", size: "M", department: "Unisex",
  price: 24.99, quantity: 1, condition: "Good", weightOz: 9, packageDims: { length: 10, width: 8, height: 1 }, photos: [{ path: "photo.jpg" }] } as CanonicalListing;
const settings = { mercariShipFrom: { zip: "12345" } } as AppSettingsData;
test("Mercari preflight accepts reviewed cents and needs no marketplace API keys", () => {
  assert.deepEqual(mercariValidate(listing, settings), []);
  const invalid = mercariValidate({ ...listing, quantity: 2, department: "Kids", price: 2001 }, settings);
  assert.deepEqual(new Set(invalid.map(issue => issue.field)), new Set(["quantity","department","price"]));
  assert.ok(mercariValidate(listing, {} as AppSettingsData).some(issue => issue.field === "shipping"));
});
test("Mercari only accepts an exact US listing identity and its own publication prefix", () => {
  assert.equal(listingIdentity("mercari", "https://www.mercari.com/us/item/m12345678901/")?.id, "m12345678901");
  for (const url of ["https://jp.mercari.com/item/m12345678901/", "https://www.mercari.com.evil.test/us/item/m12345678901/", "https://www.mercari.com/us/item/create/"]) assert.equal(listingIdentity("mercari", url), null);
  assert.equal(parseBrowserReport('MERCARI_DONE {"outcome":"filled","submissionStarted":false}', "MERCARI_DONE")?.outcome, "filled");
  assert.equal(parseBrowserReport('DEPOP_DONE {"outcome":"posted"}', "MERCARI_DONE"), null);
});
test("unknown Mercari publication outcomes cannot automatically repeat", () => {
  assert.equal(mercariPublicationError(null).notSubmitted, false);
  assert.equal(mercariPublicationError({ outcome: "failed", submissionStarted: true }).notSubmitted, false);
  assert.equal(mercariPublicationError({ outcome: "failed", submissionStarted: false }).notSubmitted, true);
});
