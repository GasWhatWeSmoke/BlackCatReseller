// Dev utility: clear all processed data (items/photos/hashes/batches/problems/
// collisions) while keeping settings + vocabulary. Used to reprocess a batch
// from scratch. Usage: node scripts/reset.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  await prisma.collision.deleteMany({});
  await prisma.problemLog.deleteMany({});
  await prisma.photo.deleteMany({});
  await prisma.fileHash.deleteMany({});
  await prisma.batch.deleteMany({});
  await prisma.item.deleteMany({});
  console.log("[reset] cleared items/photos/hashes/batches/problems/collisions (kept settings+vocab)");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
