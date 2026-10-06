import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import * as types from "./types.ts";
import * as roots from "./workRoots.ts";
import * as store from "./settingsStore.ts";

const source = ts.transpileModule(fs.readFileSync(new URL("./settings.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-required-settings-"));
  const file = path.join(dir, "test.db"); fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("blackcat-required-settings-")); fs.rmSync(dir, { recursive: true, force: true }); });
  const dependencies: Record<string, unknown> = { "node:path": path, "./db": { prisma: db }, "./types": types,
    "./workRoots": roots, "./settingsStore": store, "../../config/defaults.json": JSON.parse(fs.readFileSync("config/defaults.json", "utf8")) };
  const exports: Record<string, unknown> = {};
  vm.compileFunction(source, ["exports", "require"], { filename: "settings.ts" })(exports, (name: string) => {
    assert.ok(name in dependencies, `Unexpected settings dependency ${name}`); return dependencies[name];
  });
  return { db, required: exports.getRequiredSettings as () => Promise<types.AppSettingsData> };
}

test("required approval settings preserve configured requirements, pricing and Auto Run", async t => {
  const f = await fixture(t);
  const data = JSON.stringify({ requiredFieldsForReady: ["condition", "department"], minListingPhotos: 7,
    priceNinetyNine: "off", publish: { autoRun: { enabled: true, marketplaces: ["depop", "ebay"] } } });
  await f.db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data }, update: { data } });
  const before = await f.db.appSettings.findUniqueOrThrow({ where: { id: 1 } });
  const settings = await f.required();
  assert.equal(settings.minListingPhotos, 7); assert.deepEqual(settings.requiredFieldsForReady, ["condition", "department"]);
  assert.equal(settings.priceNinetyNine, "off"); assert.equal(settings.publish?.autoRun?.enabled, true);
  assert.deepEqual(await f.db.appSettings.findUniqueOrThrow({ where: { id: 1 } }), before);
});

test("malformed settings and failed database reads cannot turn into approval defaults", async t => {
  const f = await fixture(t);
  for (const data of ["{broken", "[]", "null", "false"]) {
    await f.db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data }, update: { data } });
    await assert.rejects(f.required(), /Saved settings could not be read/);
    assert.equal((await f.db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).data, data);
  }
  await f.db.$executeRawUnsafe("ALTER TABLE AppSettings RENAME TO UnavailableSettings");
  await assert.rejects(f.required());
});

test("an observed empty settings table still uses intentional installation defaults", async t => {
  const f = await fixture(t); await f.db.appSettings.deleteMany();
  const settings = await f.required();
  assert.equal(settings.minListingPhotos, 3); assert.equal(settings.priceNinetyNine, "down");
  assert.equal(settings.publish?.autoRun?.enabled ?? false, false);
  assert.equal(await f.db.appSettings.count(), 0);
});
