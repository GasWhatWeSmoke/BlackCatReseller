// Managed failure/recovery E2E. Phase 1 exercises the explicit operator no-AI
// intent over the normal intake path: no session/probe is opened, every item is
// imported with an honest retryable reason, and photos stay attached. Phase 2 is
// opt-in because it performs real managed inference (`E2E_MANAGED_RECOVERY=1`).
//
// Env: DATABASE_URL + BLACKCAT_DATA_ROOT must point at the isolated 7-item stack.
import { getSettings } from "../src/lib/settings";
import { runIntake } from "../src/lib/worker";
import { persistWorkerResult } from "../src/lib/persist";
import { prisma } from "../src/lib/db";
import { POST as reidentify } from "../src/app/api/items/[id]/reidentify/route";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) failures += 1;
  console.log(`  [${condition ? "ok " : "FAIL"}] ${name}${!condition && detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const settings = await getSettings();
  console.log("[e2e-no-ai] explicit force-no-AI intake (must not enter managed vision)");
  const result = await runIntake(settings, () => undefined, { forceNoAi: true });
  const skipped = result.items.map((item) => item.enrichment as typeof item.enrichment & { skipped?: boolean });
  check("all 7 worker items were produced", result.items.length === 7, String(result.items.length));
  check("every item records an intentional AI skip",
    skipped.every((entry) => entry.skipped === true && /skipped by operator request/i.test(entry.error ?? "")));

  const summary = await persistWorkerResult(result, settings);
  check("all 7 items were imported", summary.itemsCreated === 7, String(summary.itemsCreated));
  const items = await prisma.item.findMany({ orderBy: { sku: "asc" } });
  check("photos remain attached", items.every((item) => item.photoCount === 3));
  check("the retryable reason is durable",
    items.every((item) => /skipped by operator request/i.test(item.aiError ?? "")));

  if (process.env.E2E_MANAGED_RECOVERY === "1") {
    console.log("\n[e2e-no-ai] recovering through the real local-model Retry AI route");
    for (const item of items) {
      const response = await reidentify(
        new Request("http://local/api", { method: "POST" }) as never,
        { params: Promise.resolve({ id: String(item.id) }) },
      );
      const body = (await response.json()) as { ok?: boolean; error?: string };
      check(`${item.sku}: managed retry succeeded`, response.status === 200 && body.ok === true, body.error);
    }
    const recovered = await prisma.item.findMany({ orderBy: { sku: "asc" } });
    check("managed retry cleared every skip reason", recovered.every((item) => item.aiError == null));
  } else {
    console.log("[e2e-no-ai] managed recovery skipped; set E2E_MANAGED_RECOVERY=1 for supervised inference.");
  }

  console.log(`\n${failures === 0 ? "ALL EXPLICIT NO-AI CHECKS PASSED" : `EXPLICIT NO-AI FAILURES: ${failures}`}`);
  await prisma.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error("[e2e-no-ai] fatal:", error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
