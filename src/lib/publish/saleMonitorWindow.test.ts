import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { saleMonitorWindowOpen } from "./saleMonitorWindow.ts";
const { writeSaleMonitorWindow } = createRequire(import.meta.url)("../../../electron/saleMonitorWindow.js");

test("the server accepts only the owning desktop's open state and pauses when state is unavailable", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-window-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(saleMonitorWindowOpen(dir, "123"), false);
  writeSaleMonitorWindow(dir, true, 123);
  assert.equal(saleMonitorWindowOpen(dir, "123"), true);
  assert.equal(saleMonitorWindowOpen(dir, "456"), false);
  writeSaleMonitorWindow(dir, false, 123);
  assert.equal(saleMonitorWindowOpen(dir, "123"), false);
  fs.writeFileSync(path.join(dir, "sale-monitor-window.json"), "{");
  assert.equal(saleMonitorWindowOpen(dir, "123"), false);
  assert.equal(saleMonitorWindowOpen(dir, ""), true);
});
