import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { updateSettingsRow } from "./settingsStore.ts";

test("concurrent settings writers preserve frequency, restrictions and unrelated background changes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-settings-cas-"));
  const file = path.join(dir, "test.db"); fs.copyFileSync("config/template.db", file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  t.after(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.appSettings.create({ data: { id: 1, data: JSON.stringify({ publish: { saleMonitorEnabled: true } }) } });
  for (let trial = 0; trial < 6; trial++) {
    await Promise.all(["interval", "restriction", "sync"].map(key => updateSettingsRow(db, raw => {
      const current = JSON.parse(raw!);
      if (key === "interval") current.publish.saleMonitorIntervalMinutes = trial + 2;
      if (key === "restriction") current.publish.mercariListingLimit = { blocked: true, confirmedSaleSkus: ["000044"] };
      if (key === "sync") current.lastSyncSummary = `trial ${trial}`;
      return { data: JSON.stringify(current), value: current };
    })));
    const result = JSON.parse((await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).data);
    assert.equal(result.publish.saleMonitorIntervalMinutes, trial + 2);
    assert.equal(result.publish.mercariListingLimit.blocked, true);
    assert.equal(result.publish.saleMonitorEnabled, true);
    assert.equal(result.lastSyncSummary, `trial ${trial}`);
  }
});
