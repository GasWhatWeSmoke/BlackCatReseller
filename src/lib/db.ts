import { PrismaClient } from "@prisma/client";

// Prisma client singleton. The Python worker also opens the same SQLite file
// (read-only) — both rely on WAL + busy_timeout for safe concurrency.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaInit: Promise<void> | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Set connection pragmas once. WAL persists in the file (also set by init-db),
// busy_timeout is per-connection.
if (!globalForPrisma.prismaInit) {
  globalForPrisma.prismaInit = (async () => {
    // Log which database we actually opened + how much history it has, so any future
    // "data reset" is diagnosable from server.log at a glance.
    const dbUrl = (process.env.DATABASE_URL || "(default .env)").replace(/^file:/, "");
    try {
      // PRAGMAs return a row in SQLite, so use $queryRawUnsafe (not execute).
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
      const [items, batches] = await Promise.all([
        prisma.item.count().catch(() => -1),
        prisma.batch.count().catch(() => -1),
      ]);
      console.log(`[db] opened ${dbUrl} — loaded ${items} item(s), ${batches} batch(es) of history`);
    } catch (e) {
      console.error(`[db] init failed for ${dbUrl} (DB may not be migrated yet):`, e);
    }
  })();
}
export const dbReady = globalForPrisma.prismaInit;
