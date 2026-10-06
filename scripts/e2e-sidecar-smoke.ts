// Historical filename retained for operator muscle memory. This supervised smoke
// proves the app-owned local server is ready, runs one worker-owned image probe,
// and optionally identifies one real garment.
//
// Env: DATABASE_URL/BLACKCAT_DATA_ROOT -> isolated stack; optional E2E_PHOTOS is
// a comma-separated set of real photo paths for one garment.
import { getSettings } from "../src/lib/settings";
import { managedVisionStatus } from "../src/lib/visionServer";
import { runReenrich, runVisionProbe } from "../src/lib/worker";
import { prisma } from "../src/lib/db";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) failures += 1;
  console.log(`  [${condition ? "ok " : "FAIL"}] ${name}${!condition && detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const settings = await getSettings();
  const status = await managedVisionStatus(settings.visionEnabled);
  console.log(`[local-smoke] mode: ${status.mode}; runtime=${status.runtimeAvailable}; model=${status.modelAvailable}`);
  check("AI vision is enabled for this supervised smoke", settings.visionEnabled === true);
  check("app-owned local model is ready", status.ok && status.kind === "ready", status.reason);

  if (status.ok && status.kind === "ready") {
    console.log("[local-smoke] running one bounded image probe…");
    const started = Date.now();
    try {
      const probe = await runVisionProbe(settings);
      check("worker-owned managed probe completed", probe.ok === true);
      console.log(`[local-smoke] probe completed in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      check("worker-owned managed probe completed", false,
        error instanceof Error ? error.message : String(error));
    }

    const requestedPaths = (process.env.E2E_PHOTOS ?? "").split(",")
      .map((value) => value.trim()).filter(Boolean);
    if (requestedPaths.length) {
      const stored = await prisma.photo.findMany({
        where: { storedPath: { in: requestedPaths }, isMarker: false },
        select: { id: true, storedPath: true, isMarker: true, sha256: true },
      });
      const byPath = new Map(stored.map((photo) => [photo.storedPath, photo]));
      const photos = requestedPaths.map((storedPath) => byPath.get(storedPath));
      if (photos.some((photo) => !photo)) {
        throw new Error("E2E_PHOTOS must name existing managed Photo rows under processingPath");
      }
      console.log(`[local-smoke] identifying one item from ${photos.length} real photo(s)…`);
      const enrichment = await runReenrich(settings, "SMOKE", photos.map((photo) => ({
        photoId: photo!.id,
        storedPath: photo!.storedPath,
        isMarker: photo!.isMarker,
        sha256: photo!.sha256,
      })));
      const raw = (enrichment.raw ?? {}) as Record<string, unknown>;
      check("real managed enrichment returned no error", !enrichment.error, enrichment.error);
      check("real managed enrichment identified itemType", !!enrichment.fields?.itemType,
        enrichment.fields?.itemType);
      check("real managed enrichment wrote a description",
        String(raw.description ?? "").length > 50);
    } else {
      console.log("[local-smoke] E2E_PHOTOS unset; bounded probe only.");
    }
  }

  console.log(`\n${failures === 0 ? "ALL MANAGED VISION SMOKE CHECKS PASSED" : `MANAGED VISION SMOKE FAILURES: ${failures}`}`);
  await prisma.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error("[managed-smoke] fatal:", error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
