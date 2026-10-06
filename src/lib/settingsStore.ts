import type { PrismaClient } from "@prisma/client";

/** Compare-and-swap protects every writer, including writers in another process.
 * Recompute the change on the latest row; never retry a stale full snapshot. */
export async function updateSettingsRow<T>(
  db: Pick<PrismaClient, "appSettings">,
  update: (data: string | null) => { data: string; value: T },
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await db.appSettings.findUnique({ where: { id: 1 } });
    const next = update(row?.data ?? null);
    if (row) {
      const result = await db.appSettings.updateMany({ where: { id: 1, data: row.data }, data: { data: next.data } });
      if (result.count === 1) return next.value;
    } else {
      try { await db.appSettings.create({ data: { id: 1, data: next.data } }); return next.value; }
      catch (error) { if ((error as { code?: string }).code !== "P2002") throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(5 * (attempt + 1), 50)));
  }
  throw new Error("Settings changed repeatedly while saving. Please try again.");
}
