// One-off (stale-price cleanup, 2026-07-10): after DELETING the old draft/live listings
// on Nifty by hand, run this to put every "on Nifty" item back into the Ready queue so a
// fresh test run can upload them at their CURRENT prices.
//
// It is the bulk equivalent of clicking Re-list on each item — use it ONLY after the old
// copies are gone from Nifty, or the next run will duplicate them again (the per-item
// guard you'd normally hit exists precisely to stop that).
//
// Run from the project root (the app can stay open; restart it AFTER so the UI refreshes):
//   node scripts/requeue-after-nifty-cleanup.mjs          <- dry run (prints what it would do)
//   node scripts/requeue-after-nifty-cleanup.mjs --apply  <- actually resets them
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

const items = await prisma.item.findMany({
  where: { niftyStatus: { in: ["Uploading", "Draft", "Published"] } },
  select: { id: true, sku: true, niftyStatus: true, listedPrice: true },
  orderBy: { sku: "asc" },
});

if (!items.length) {
  console.log("Nothing to re-queue — no items are marked as on Nifty.");
  process.exit(0);
}

let unpriced = 0;
for (const it of items) {
  const price = it.listedPrice != null ? `$${it.listedPrice.toFixed(2)}` : "NO PRICE (will be blocked)";
  if (it.listedPrice == null || it.listedPrice <= 0) unpriced++;
  console.log(`${it.sku}: ${it.niftyStatus} -> Ready for Nifty @ ${price}`);
  if (apply) {
    await prisma.item.update({
      where: { id: it.id },
      data: { status: "Ready for Nifty", niftyStatus: "Not Uploaded" },
    });
  }
}

console.log(`\n${apply ? "Re-queued" : "Would re-queue"} ${items.length} item(s).`);
if (unpriced) console.log(`⚠ ${unpriced} item(s) have no price — set them in the Pricing tab first (the worker now blocks unpriced drafts too).`);
if (!apply) console.log("Dry run only — re-run with --apply to do it.");
await prisma.$disconnect();
