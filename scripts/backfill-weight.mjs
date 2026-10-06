// One-off: estimate ship weight (oz) for items that don't have one yet.
// Mirrors the WEIGHT_OZ table in src/lib/listing.ts.
import { PrismaClient } from "@prisma/client";

const WEIGHT_OZ = {
  "t-shirt": 6, tee: 6, shirt: 8, top: 7, blouse: 7, tank: 4,
  hoodie: 22, sweatshirt: 18, sweater: 16, cardigan: 16,
  jacket: 18, coat: 40, blazer: 18, vest: 10,
  pants: 16, jeans: 24, leggings: 7, joggers: 16, sweatpants: 16,
  shorts: 9, dress: 10, skirt: 9, romper: 12, jumpsuit: 16,
  hat: 4, cap: 4, beanie: 3, scarf: 4, belt: 7, bag: 16, purse: 16,
  shoes: 32, sneakers: 36, boots: 48, sandals: 18, heels: 26,
};
const est = (t) => WEIGHT_OZ[(t || "").trim().toLowerCase()] ?? 12;

const prisma = new PrismaClient();
// Overwrite all items with the current estimate (re-tuned weights).
const items = await prisma.item.findMany({});
let n = 0;
for (const it of items) {
  const oz = est(it.itemType);
  await prisma.item.update({ where: { id: it.id }, data: { weightOz: oz } });
  console.log(`${it.sku}: ${it.itemType || "?"} -> ${oz} oz`);
  n++;
}
console.log(`[backfill] set weight on ${n} item(s)`);
await prisma.$disconnect();
