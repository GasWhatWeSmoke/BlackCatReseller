import test from "node:test";
import assert from "node:assert/strict";
import { checkpointProblem, createReviewCheckpoint, parseReviewCheckpoint, reviewContent, reviewHotkey, reviewKey, reviewProblems, reviewRules,
  type ReviewCheckpoint, type ReviewItem } from "./reviewCheckpoint.ts";
import { approveReviewedBatch, type BatchReviewOperations } from "./bulkReview.ts";

const rules = reviewRules({ requiredFieldsForReady: ["size", "itemType", "color", "condition"], minListingPhotos: 1 });

test("review shortcuts distinguish batch review and never approve through dialogs or text composition", () => {
  assert.equal(reviewHotkey({ key: "Enter" }, false), "approve");
  assert.equal(reviewHotkey({ key: "Enter", ctrlKey: true }, false), "batch");
  assert.equal(reviewHotkey({ key: "Enter" }, true), null);
  for (const state of [{ isComposing: true }, { defaultPrevented: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }])
    assert.equal(reviewHotkey({ key: "Enter", ...state }, false), null);
  assert.equal(reviewHotkey({ key: "Escape" }, false), null);
});
function item(id = 1): ReviewItem {
  return { id, sku: String(id).padStart(6, "0"), createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T01:00:00.000Z",
    status: "Needs Info", niftyStatus: "Not Uploaded", brand: "Quiksilver", itemType: "T-shirt", category: "Clothing", size: "L", color: "Blue",
    condition: "Good", department: "Men", listedPrice: 25, aiRaw: null, keyDetails: "", trueVintage: false, etsyEligible: "none",
    photos: [{ id, storedPath: `C:/fixture/${id}.jpg`, sha256: "a".repeat(64), sortOrder: 0, rotation: 0, isMarker: false, isCover: true, includeInListing: true }],
    marketplaceListings: [] };
}

test("an explicit individual review creates a checkpoint without making the item Ready", async () => {
  const original = item(); const checkpoint = await createReviewCheckpoint(original, original, original.updatedAt, rules);
  assert.equal(checkpoint.phase, "reviewed"); assert.equal(original.status, "Needs Info");
  assert.equal(checkpoint.price, 25); assert.equal(checkpoint.photos, 1); assert.match(checkpoint.title, /Quiksilver/);
  assert.equal(await checkpointProblem(checkpoint, original, rules), null);
  assert.deepEqual(parseReviewCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
});

test("unseen photo, copy, price, identity or version changes cannot become a review checkpoint", async () => {
  const original = item();
  for (const patch of [{ listedPrice: 30 }, { keyDetails: "Different detail" }, { description: "A newly edited listing description." }, { createdAt: "2026-09-21T00:00:00.000Z" },
    { updatedAt: "2026-09-20T01:00:01.000Z" }, { photos: [{ ...original.photos[0], rotation: 90 }] }]) {
    await assert.rejects(createReviewCheckpoint(original, { ...original, ...patch }, original.updatedAt, rules), /changed during review/);
  }
});

test("field normalization matches saving while explicit clears remain distinct", async () => {
  const source = { ...item(), pattern: "", weightOz: 12.4, keyDetails: "" };
  const saved = { ...source, weightOz: 12, aiFields: null, evidenceJson: '{"brand":{"status":"confirmed"}}' };
  assert.equal(reviewContent(source), reviewContent(saved));
  assert.notEqual(reviewContent(source), reviewContent({ ...source, keyDetails: null }));
  await createReviewCheckpoint(source, saved, saved.updatedAt, rules);
});

test("every selected-photo change invalidates a completed review", async () => {
  const source = item(); const checkpoint = await createReviewCheckpoint(source, source, source.updatedAt, rules);
  for (const patch of [{ id: 7 }, { storedPath: "C:/other.jpg" }, { sha256: "b".repeat(64) }, { sortOrder: 3 }, { rotation: 180 },
    { isMarker: true }, { isCover: false }, { includeInListing: false }]) {
    assert.match((await checkpointProblem(checkpoint, { ...source, photos: [{ ...source.photos[0], ...patch }] }, rules))!, /changed after/);
  }
  assert.match((await checkpointProblem(checkpoint, { ...source, updatedAt: "2026-09-20T02:00:00.000Z" }, rules))!, /changed after/);
});

test("readiness, existing activity and settings remain gates for individual review", () => {
  for (const status of ["Ready", "Sold", "Archived", "Removed"]) assert.ok(reviewProblems({ ...item(), status }, rules).length);
  for (const value of [{ brand: "Unknown" }, { listedPrice: 0 }, { department: null }, { photos: [] }, { sku: "../unsafe" },
    { marketplaceListings: [{ marketplace: "ebay", status: "published" }] }, { republicationBlockReason: "A direct upload is pending" }])
    assert.ok(reviewProblems({ ...item(), ...value }, rules).length);
  assert.ok(reviewProblems({ ...item(), weightOz: 0 }, { ...rules, required: [...rules.required, "weightOz"] }).length);
  assert.throws(() => reviewRules({ requiredFieldsForReady: [], minListingPhotos: NaN }));
  assert.throws(() => reviewRules(null));
});

test("list and detail marketplace projections describe the same reviewed facts", () => {
  const listed = { ...item(), marketplaceListings: [{ marketplace: "ebay", status: "ended" }] };
  const detail = { ...item(), marketplaceListings: [{ marketplace: "ebay", status: "ended", externalListingId: "old", price: 20 }] };
  assert.equal(reviewContent(listed), reviewContent(detail));
});

async function batchFixture(count = 3) {
  const items = new Map(Array.from({ length: count }, (_, n) => { const value = item(n + 1); return [value.id, value]; }));
  const checkpoints = await Promise.all([...items.values()].map(value => createReviewCheckpoint(value, value, value.updatedAt, rules)));
  const stored = new Map(checkpoints.map(checkpoint => [checkpoint.key, { ...checkpoint }]));
  const calls: number[] = [], completed: number[] = [];
  const operations: BatchReviewOperations = {
    readItem: async id => items.get(id) ?? null,
    readRules: async () => rules,
    exclusive: async (_key, work) => work(),
    claim: async checkpoint => {
      const current = stored.get(checkpoint.key)!;
      if (current.revision !== checkpoint.revision || current.phase !== "reviewed") throw new Error("Review changed after confirmation");
      const claim: ReviewCheckpoint = { ...current, phase: "approving", attempt: String(checkpoint.id) };
      stored.set(checkpoint.key, claim); return claim;
    },
    finish: async (claim, phase, note) => { stored.set(claim.key, { ...claim, phase, note }); },
    approve: async value => { calls.push(value.id); items.set(value.id, { ...value, status: "Ready" }); return { kind: "approved", message: "Approved" }; },
  };
  return { items, checkpoints, stored, calls, operations, options: { stopped: () => false, progress: (result: { id: number }) => { completed.push(result.id); } }, completed };
}

test("a 100-item reviewed batch approves each item exactly once and rejects replay", async () => {
  const f = await batchFixture(100);
  const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
  assert.equal(result.remaining, 0); assert.equal(result.results.filter(value => value.kind === "approved").length, 100);
  assert.equal(new Set(f.calls).size, 100);
  await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
  assert.equal(f.calls.length, 100);
  assert.ok([...f.stored.values()].every(checkpoint => checkpoint.phase === "approved"));
});

test("changed items and rejected claims are skipped without approving them", async () => {
  const f = await batchFixture(4);
  f.items.set(1, { ...f.items.get(1)!, listedPrice: 100 });
  f.stored.set(f.checkpoints[1].key, { ...f.checkpoints[1], revision: "changed-window" });
  const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
  assert.deepEqual(f.calls, [3, 4]); assert.deepEqual(result.results.map(value => value.kind), ["blocked", "blocked", "approved", "approved"]);
});

test("known preparation failures retain separate outcomes while later valid items proceed", async () => {
  const f = await batchFixture(); const approve = f.operations.approve;
  f.operations.approve = async item => item.id === 2 ? { kind: "blocked", message: "Missing photo file" } : approve(item);
  const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
  assert.deepEqual(result.results.map(value => value.kind), ["approved", "blocked", "approved"]);
  assert.equal(f.stored.get(reviewKey(item(2)))?.phase, "blocked");
});

test("an unknown response or journal failure stops untouched remaining items without retry", async () => {
  for (const journalFailure of [false, true]) {
    const f = await batchFixture(); const approve = f.operations.approve;
    if (journalFailure) f.operations.finish = async () => { throw new Error("Storage failure"); };
    else f.operations.approve = async item => { await approve(item); throw new Error("Response lost after mutation"); };
    const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
    assert.deepEqual(f.calls, [1]); assert.equal(result.results[0].kind, "unknown"); assert.equal(result.remaining, 2);
    assert.equal(f.stored.get(reviewKey(item(2)))?.phase, "reviewed");
  }
});

test("stopping waits for the current item and leaves later checkpoints untouched", async () => {
  const f = await batchFixture(); let stop = false;
  const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, { stopped: () => stop, progress: () => { stop = true; } });
  assert.deepEqual(f.calls, [1]); assert.equal(result.remaining, 2); assert.equal(f.stored.get(reviewKey(item(1)))?.phase, "approved");
  assert.equal(f.stored.get(reviewKey(item(2)))?.phase, "reviewed");
});

test("changed Auto Run settings or unavailable saved settings stop before another approval", async () => {
  for (const fails of [false, true]) {
    const f = await batchFixture(); let reads = 0;
    f.operations.readRules = async () => { if (++reads === 1) return rules; if (fails) throw new Error("Settings unavailable"); return { ...rules, autoRun: true }; };
    const result = await approveReviewedBatch(f.checkpoints, rules, f.operations, f.options);
    assert.deepEqual(f.calls, [1]); assert.equal(result.results[1].kind, "blocked"); assert.equal(result.remaining, 1);
  }
});

test("empty, duplicate and oversized selections cannot begin a batch", async () => {
  const f = await batchFixture();
  for (const selection of [[], [f.checkpoints[0], f.checkpoints[0]], Array(101).fill(f.checkpoints[0])])
    await assert.rejects(approveReviewedBatch(selection, rules, f.operations, f.options), /distinct/);
  assert.equal(f.calls.length, 0);
});
