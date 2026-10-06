// End-to-end mixed-batch test: drives the REAL pipeline code (runIntake ->
// persistWorkerResult -> exportItemById) against an ISOLATED temp DB + data root,
// through the same serialized localhost boundary as production, with an
// isolated OpenAI-compatible HTTP test server. Verifies every
// item — shirt, jeans, handbag, belt, scarf,
// necklace, bucket hat — receives category, specific item type, title,
// description, price, weight/dims, and the marketplace fields in item.json.
//
// DATABASE_URL/BLACKCAT_DATA_ROOT must point at the temp stack. A busy lock is retry-later.
// Build: esbuild scripts/e2e-mixed-batch.ts --bundle --platform=node
//        --format=cjs --external:@prisma/client --outfile=node_modules/.e2e/runner.cjs
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../src/lib/settings";
import { runIntake } from "../src/lib/worker";
import { persistWorkerResult } from "../src/lib/persist";
import { exportItemById } from "../src/lib/export-item";
import { estimatePrice } from "../src/lib/listing";
import { prisma } from "../src/lib/db";

interface Expect {
  sku: string;
  category: string;
  itemType: string;
  sizeInJson: string;        // what item.json.size must be after export
  sizeless: boolean;
  weightOz: number;
  dims: { length: number; width: number; height: number };
  categoryLike: RegExp;      // listing category in item.json
  titleMust: RegExp[];
}

const EXPECT: Expect[] = [
  { sku: "900001", category: "Clothing", itemType: "Shirt", sizeInJson: "M", sizeless: false,
    weightOz: 8, dims: { length: 13, width: 10, height: 1 }, categoryLike: /Tops & Tees/,
    titleMust: [/Ralph Lauren/, /Shirt/, /Size M/] },
  { sku: "900002", category: "Clothing", itemType: "Jeans", sizeInJson: "32x32", sizeless: false,
    weightOz: 24, dims: { length: 13, width: 10, height: 1 }, categoryLike: /Jeans/,
    titleMust: [/Levi's/, /Jeans/, /32x32/] },
  { sku: "900003", category: "Bag", itemType: "Handbag", sizeInJson: "One Size", sizeless: true,
    weightOz: 18, dims: { length: 13, width: 10, height: 5 }, categoryLike: /Bags & Purses/,
    titleMust: [/Coach/, /Handbag/, /Brown/] },
  { sku: "900004", category: "Accessory", itemType: "Belt", sizeInJson: "34", sizeless: false,
    weightOz: 7, dims: { length: 9, width: 6, height: 1 }, categoryLike: /Belts/,
    titleMust: [/Belt/, /Black/, /Size 34/] },
  { sku: "900005", category: "Accessory", itemType: "Scarf", sizeInJson: "One Size", sizeless: true,
    weightOz: 4, dims: { length: 9, width: 6, height: 1 }, categoryLike: /Scarves & Wraps/,
    titleMust: [/Scarf/, /Red/, /Striped/] },
  { sku: "900006", category: "Jewelry", itemType: "Necklace", sizeInJson: "One Size", sizeless: true,
    weightOz: 3, dims: { length: 7, width: 5, height: 2 }, categoryLike: /Jewelry/,
    titleMust: [/Necklace/, /Gold/] },
  { sku: "900007", category: "Hat", itemType: "Bucket Hat", sizeInJson: "One Size", sizeless: true,
    weightOz: 4, dims: { length: 9, width: 6, height: 1 }, categoryLike: /Hats/,
    titleMust: [/Nike/, /Bucket Hat/, /Green/] },
];

let failures = 0;
let managedItemsCompleted = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`  [${cond ? "ok " : "FAIL"}] ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const settings = await getSettings();
  console.log(`[e2e] data root: ${settings.dataRoot}`);
  console.log(`[e2e] vision:    local llama.cpp (${settings.visionEnabled ? "enabled" : "disabled"})`);

  // ---- 1) Intake: the real worker over the fixture batch --------------------
  const result = await runIntake(settings, (ev) => {
    if (ev.stage === "enrich_done") {
      managedItemsCompleted++;
      console.log(`[worker] AI ${ev.sku}: ${ev.ok ? "ok " + JSON.stringify(ev.fields) : "FAILED " + ev.error}`);
    }
  });
  console.log(`[e2e] worker done: ${result.items.length} item(s), ${result.problems.length} problem(s)`);

  // ---- 2) Persist through the real persist path ------------------------------
  const summary = await persistWorkerResult(result, settings);
  console.log(`[e2e] persisted: ${JSON.stringify(summary)}`);
  console.log("\n== batch-level checks ==");
  check("7 items created", summary.itemsCreated === 7, String(summary.itemsCreated));
  check("no AI failures", summary.aiFailed === 0, `aiFailed=${summary.aiFailed} first=${summary.aiFirstError}`);
  check("AI ran for all 7", summary.aiTotal === 7, String(summary.aiTotal));
  check("managed session completed all 7 item asks", managedItemsCompleted === 7,
    String(managedItemsCompleted));

  // ---- 3) Per-item DB verification + operator step (condition + price) ------
  for (const exp of EXPECT) {
    console.log(`\n== ${exp.sku} (${exp.itemType}) ==`);
    const item = await prisma.item.findUnique({ where: { sku: exp.sku } });
    if (!item) { check("item exists", false); continue; }
    check("category detected", item.category === exp.category, `got ${item.category}`);
    check("SPECIFIC itemType", item.itemType === exp.itemType, `got ${item.itemType}`);
    check("no aiError", item.aiError == null, item.aiError ?? "");
    check("aiRaw stored", !!item.aiRaw);
    check("aiConfidence stored", item.aiConfidence != null);
    check("color filled", !!item.color, String(item.color));
    check("description filled (30+ chars)", (item.description ?? "").length > 30);
    check("ship weight auto-estimated", item.weightOz === exp.weightOz, `got ${item.weightOz}, want ${exp.weightOz}`);
    const suggested = estimatePrice(item.itemType);
    check("price suggestion exists", suggested != null, String(suggested));
    // Operator step: accept the suggested price + set condition (the two
    // operator-owned fields), exactly what Review does.
    await prisma.item.update({
      where: { id: item.id },
      data: { listedPrice: suggested ?? 20, condition: "Good" },
    });
  }

  // ---- 4) Export every item through the real gate + export worker ------------
  console.log("\n== exports ==");
  for (const exp of EXPECT) {
    const item = await prisma.item.findUnique({ where: { sku: exp.sku } });
    if (!item) continue;
    const r = await exportItemById(item.id);
    console.log(`\n== export ${exp.sku} (${exp.itemType}) ==`);
    if (!r.ok) {
      check(`export succeeded`, false, `${r.error}${"missing" in r ? " missing=" + r.missing.join(",") : ""}`);
      continue;
    }
    check("export succeeded (gate passed)", true);
    const itemJson = JSON.parse(fs.readFileSync(path.join(r.readyDir, "item.json"), "utf-8"));
    check("json: category group", itemJson.categoryGroup === exp.category, `got ${itemJson.categoryGroup}`);
    check("json: itemType", itemJson.itemType === exp.itemType, `got ${itemJson.itemType}`);
    check("json: size", itemJson.size === exp.sizeInJson, `got ${JSON.stringify(itemJson.size)}`);
    check("json: sizeless flag", itemJson.sizeless === exp.sizeless, String(itemJson.sizeless));
    check("json: listing category", exp.categoryLike.test(itemJson.category), `got ${itemJson.category}`);
    check("json: title non-generic <=80", typeof itemJson.title === "string" && itemJson.title.length >= 20 && itemJson.title.length <= 80, itemJson.title);
    for (const re of exp.titleMust) check(`json: title has ${re}`, re.test(itemJson.title), itemJson.title);
    check("json: description 100+ chars", typeof itemJson.description === "string" && itemJson.description.length >= 100, `${(itemJson.description ?? "").length} chars`);
    check("json: no 'unknown' in copy", !/unknown/i.test(itemJson.title + " " + itemJson.description));
    check("json: price set", typeof itemJson.price === "number" && itemJson.price > 0, String(itemJson.price));
    check("json: weight", itemJson.weightOz === exp.weightOz, `got ${itemJson.weightOz}`);
    check("json: package dims", JSON.stringify(itemJson.packageDims) === JSON.stringify(exp.dims), JSON.stringify(itemJson.packageDims));
    check("json: condition", itemJson.condition === "Good");
    check("json: photos exported", Array.isArray(itemJson.listingPhotos) && itemJson.listingPhotos.length === 3, String(itemJson.listingPhotos?.length));
    for (const p of itemJson.listingPhotos ?? []) {
      check(`photo file exists: ${p}`, fs.existsSync(path.join(r.readyDir, p)));
    }
    const notes = fs.readFileSync(path.join(r.readyDir, "notes.txt"), "utf-8");
    check("notes.txt has Category Group", notes.includes(`Category Group: ${exp.category}`));
    const fresh = await prisma.item.findUnique({ where: { sku: exp.sku } });
    check("status -> Ready for Nifty", fresh?.status === "Ready for Nifty", fresh?.status);
  }

  console.log(`\n${failures === 0 ? "ALL E2E CHECKS PASSED" : `E2E FAILURES: ${failures}`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[e2e] fatal:", e); process.exit(1); });
