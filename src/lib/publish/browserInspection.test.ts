import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserInspection, saveBrowserInspection, browserInspections, clearBrowserInspections } from "./browserInspection.ts";

const sample = { marketplace: "ebay", tabId: 1, url: "https://www.ebay.com/lstng?draftId=123",
  page: { state: "seller_page", path: "/lstng", headings: ["Complete your listing"], controls: [{ name: "title", value: "Shirt" }] } };
test("inspection storage accepts bounded seller metadata and rejects secret URL parameters or arbitrary data", () => {
  assert.ok(parseBrowserInspection(sample));
  assert.equal(parseBrowserInspection({ ...sample, url: sample.url + "&token=secret" }), null);
  assert.equal(parseBrowserInspection({ ...sample, marketplace: "etsy" }), null);
  assert.equal(parseBrowserInspection({ ...sample, page: { ...sample.page, controls: [{ cookies: "secret" }] } }), null);
  assert.equal(parseBrowserInspection({ ...sample, page: { ...sample.page, controls: Array(181).fill({}) } }), null);
  assert.equal(parseBrowserInspection({ ...sample, page: { ...sample.page, path: "/different" } }), null);
});
test("only the latest inspection per platform is kept, and disconnect clears it", () => {
  clearBrowserInspections();
  const value = parseBrowserInspection(sample)!;
  saveBrowserInspection(value);
  saveBrowserInspection({ ...value, tabId: 2 });
  assert.equal(browserInspections().length, 1);
  assert.equal(browserInspections()[0].tabId, 2);
  clearBrowserInspections();
  assert.equal(browserInspections().length, 0);
});
