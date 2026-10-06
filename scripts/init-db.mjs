// One-time DB initialization: enable WAL (persists in the file), seed the
// single AppSettings row, and seed default controlled vocabulary.
// Run AFTER `prisma migrate`/`prisma db push`.  Usage: node scripts/init-db.mjs
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const prisma = new PrismaClient();

// Static (non-path) defaults come from the SINGLE source of truth shared with
// src/lib/settings.ts and the Python worker (§28). Only the env-derived paths are
// computed here, so the seeded row can never drift from what the app/worker expect.
function staticDefaults() {
  const p = path.join(projectRoot, "config", "defaults.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).defaults;
}

function defaultSettings() {
  const dataRoot =
    process.env.BLACKCAT_DATA_ROOT || path.join(projectRoot, "var");
  const j = (...p) => path.join(dataRoot, ...p);
  const python =
    process.env.BLACKCAT_PYTHON ||
    path.join(projectRoot, "worker", ".venv", "Scripts", "python.exe");
  return {
    ...staticDefaults(),
    dataRoot,
    incomingPath: j("incoming"),
    processingPath: j("processing"),
    readyPath: j("ready"),
    needsReviewPath: j("needs-review"),
    archivePath: j("archive"),
    exportsPath: j("exports"),
    logsPath: j("logs"),
    backupsPath: j("backups"),
    pythonWorkerPath: python,
  };
}

const VOCAB = {
  size: ["XS", "S", "M", "L", "XL", "XXL", "One Size"],
  itemType: [
    "T-Shirt",
    "Hoodie",
    "Sweatshirt",
    "Jacket",
    "Jeans",
    "Pants",
    "Shorts",
    "Dress",
    "Hat",
    "Shoes",
    // Accessories (2026-08-05 expansion) — specific types the vision model now emits.
    "Handbag",
    "Shoulder Bag",
    "Crossbody Bag",
    "Tote Bag",
    "Backpack",
    "Clutch",
    "Messenger Bag",
    "Duffel Bag",
    "Wallet",
    "Pouch",
    "Belt",
    "Scarf",
    "Necklace",
    "Bracelet",
    "Ring",
    "Earrings",
    "Brooch",
    "Watch",
    "Baseball Cap",
    "Snapback",
    "Beanie",
    "Bucket Hat",
    "Cowboy Hat",
    "Fedora",
    "Sunglasses",
    "Tie",
    "Gloves",
    "Bandana",
  ],
  color: [
    "Black",
    "White",
    "Gray",
    "Blue",
    "Red",
    "Green",
    "Yellow",
    "Brown",
    "Multi",
  ],
  brand: ["Unknown"],
};

async function main() {
  // WAL persists in the database file once set. PRAGMA returns a row, so use
  // $queryRawUnsafe (executeRawUnsafe rejects result-returning statements).
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");

  const existing = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!existing) {
    const settings = defaultSettings();
    for (const key of ['incomingPath', 'processingPath', 'readyPath', 'needsReviewPath', 'archivePath', 'exportsPath', 'logsPath', 'backupsPath']) {
      fs.mkdirSync(settings[key], { recursive: true });
    }
    await prisma.appSettings.create({
      data: { id: 1, data: JSON.stringify(settings) },
    });
    console.log("[init-db] seeded AppSettings");
  } else {
    console.log("[init-db] AppSettings already present, leaving as-is");
  }

  let added = 0;
  for (const [type, values] of Object.entries(VOCAB)) {
    for (let i = 0; i < values.length; i++) {
      await prisma.vocabulary.upsert({
        where: { type_value: { type, value: values[i] } },
        update: {},
        create: { type, value: values[i], sortOrder: i },
      });
      added++;
    }
  }
  console.log(`[init-db] vocabulary ensured (${added} entries)`);
  console.log("[init-db] done. WAL enabled.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
