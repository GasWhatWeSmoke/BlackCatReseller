import type { PrismaClient } from "@prisma/client";

/** Recovery of an older batch must remain visible over newer finished batches. */
export async function statusRun(db: Pick<PrismaClient, "publishRun">, runId?: number) {
  if (runId !== undefined) return db.publishRun.findUnique({ where: { id: runId } });
  return await db.publishRun.findFirst({
    where: { jobs: { some: { status: "publishing" } } }, orderBy: { id: "desc" },
  }) ?? await db.publishRun.findFirst({
    where: { status: "running" }, orderBy: { id: "desc" },
  }) ?? await db.publishRun.findFirst({
    where: { status: "paused" }, orderBy: { id: "desc" },
  }) ?? await db.publishRun.findFirst({ orderBy: { id: "desc" } });
}
