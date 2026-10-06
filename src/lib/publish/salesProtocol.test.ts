import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSaleObservation, parseSalesReport } from "./salesProtocol.ts";
import { validateSalesCheckpoint } from "./salesCheckpoint.ts";

const raw = { marketplace: "depop", receiptId: "123", listingId: "seller-shirt", listingUrl: "https://www.depop.com/products/seller-shirt/", classification: "confirmed_sale" };
const payload = { ok: true, complete: true, receiptIds: ["123"], checkedReceiptIds: ["123"], confirmedReceiptIds: ["123"], observations: [raw] };
const report = (value: unknown) => `DEPOP_SALES_DONE ${JSON.stringify(value)}\n`;

test("receipt actuals survive checkpointing while invalid money cannot block a sale", () => {
  const financials = { currency: "USD", salePriceCents: 1999, shippingChargedCents: 589, soldAt: "2026-09-11T00:00:00.000Z" };
  const observation = normalizeSaleObservation("depop", { ...raw, financials: { ...financials, buyer: "omitted" } })!;
  assert.deepEqual(observation.financials, financials);
  assert.deepEqual(validateSalesCheckpoint({ version: 1, receipts: [{ marketplace: "depop", receiptId: "123", observations: [observation] }] }).receipts[0].observations[0].financials, financials);
  for (const invalid of [{ ...financials, currency: "EUR" }, { ...financials, salePriceCents: 19.99 },
    { ...financials, shippingChargedCents: -1 }, { ...financials, soldAt: "2026-02-30T00:00:00.000Z" }]) {
    const row = normalizeSaleObservation("depop", { ...raw, financials: invalid })!;
    assert.equal(row.classification, "confirmed_sale"); assert.equal(row.financials, undefined);
  }
  assert.equal(normalizeSaleObservation("depop", { ...raw, classification: "not_sale", financials })!.financials, undefined);
});

test("sales reports require exact products and omit unrelated customer data", () => {
  const parsed = parseSalesReport(report({ ...payload, observations: [{ ...raw, buyer: "not retained", address: "not retained" }] }), "depop")!;
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.observations[0], { ...raw, reference: "123" });
  for (const invalid of [{ ...raw, listingId: "other" }, { ...raw, marketplace: "ebay" },
    { ...raw, listingId: undefined, listingUrl: undefined }, { ...raw, receiptId: "../bad" }]) {
    assert.equal(normalizeSaleObservation("depop", invalid), null);
  }
});

test("a receipt cannot be checkpointed without complete confirmed observations", () => {
  for (const invalid of [{ ...payload, observations: [] }, { ...payload, checkedReceiptIds: [] },
    { ...payload, receiptIds: [] }, { ...payload, observations: [{ ...raw, classification: "requires_review" }] },
    { ...payload, observations: [raw, raw] }]) assert.equal(parseSalesReport(report(invalid), "depop"), null);
  assert.equal(parseSalesReport(report(payload) + "DEPOP_SALES_DONE broken\n", "depop"), null);
  assert.equal(parseSalesReport(report(payload), "poshmark"), null);
});

test("Poshmark retains exact order-line references and cannot import another platform's report", () => {
  const orderId = "abcdef123456789012345678", lineId = "111111123456789012345678";
  const row = { marketplace: "poshmark", orderId, lineId, listingId: "222222123456789012345678",
    listingUrl: "https://poshmark.com/listing/222222123456789012345678", classification: "confirmed_sale" };
  const parsed = parseSalesReport(`POSHMARK_SALES_DONE ${JSON.stringify({ ok: true, complete: true, observations: [row] })}\n`, "poshmark")!;
  assert.equal(parsed.observations[0].reference, `${orderId}/${lineId}`);
  assert.deepEqual(parsed.confirmedReceiptIds, [orderId]);
  const checkpoint = validateSalesCheckpoint({ version: 1, receipts: [{ marketplace: "poshmark", receiptId: orderId, observations: parsed.observations }] });
  assert.deepEqual(checkpoint.receipts[0].observations, parsed.observations);
});

test("checkpoints cannot cache unconfirmed observations or duplicate receipts", () => {
  const observation = normalizeSaleObservation("depop", raw)!;
  const receipt = { marketplace: "depop", receiptId: "123", observations: [observation] };
  assert.throws(() => validateSalesCheckpoint({ version: 1, receipts: [receipt, receipt] }), /Duplicate/);
  assert.throws(() => validateSalesCheckpoint({ version: 1, receipts: [{ ...receipt,
    observations: [{ ...observation, classification: "not_sale" }] }] }), /unconfirmed/);
});

test("Mercari sales require exact seller-order references and confirmed receipt coverage", () => {
  const id = "m12345678901";
  const observation = { marketplace: "mercari", receiptId: id, reference: `${id}/${id}`, listingId: id,
    listingUrl: `https://www.mercari.com/us/item/${id}/`, classification: "confirmed_sale" };
  const value = { ok: true, complete: true, receiptIds: [id], checkedReceiptIds: [id], confirmedReceiptIds: [id], observations: [observation] };
  const encode = (body: unknown) => `MERCARI_SALES_DONE ${JSON.stringify(body)}`;
  assert.deepEqual(parseSalesReport(encode(value), "mercari")?.confirmedReceiptIds, [id]);
  assert.equal(parseSalesReport(encode({ ...value, checkedReceiptIds: [] }), "mercari"), null);
  assert.equal(normalizeSaleObservation("mercari", { ...observation, reference: id }), null);
});

test("eBay and Etsy receipts need exact references and fully checked order contents", () => {
  for (const marketplace of ["ebay", "etsy"] as const) {
    const receiptId = marketplace === "ebay" ? "12-12345-12345" : "1234567890";
    const row = { marketplace, receiptId, reference: `${receiptId}/123456789012`, listingId: "123456789012",
      listingUrl: `https://www.${marketplace}.com/${marketplace === "ebay" ? "itm" : "listing"}/123456789012`, classification: "confirmed_sale" };
    const value = { ...payload, receiptIds: [receiptId], checkedReceiptIds: [receiptId], confirmedReceiptIds: [receiptId], observations: [row] };
    const encode = (body: unknown) => `${marketplace.toUpperCase()}_SALES_DONE ${JSON.stringify(body)}\n`;
    const parsed = parseSalesReport(encode(value), marketplace)!;
    assert.deepEqual(parsed.confirmedReceiptIds, [receiptId]);
    assert.equal(normalizeSaleObservation(marketplace, { ...row, reference: `${receiptId}/other` }), null);
    assert.equal(parseSalesReport(encode({ ...value, checkedReceiptIds: [] }), marketplace), null);
    assert.equal(validateSalesCheckpoint({ version: 1, receipts: [{ marketplace, receiptId, observations: parsed.observations }] }).receipts.length, 1);
  }
});
