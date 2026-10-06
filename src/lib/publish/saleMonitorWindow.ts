import fs from "node:fs";
import path from "node:path";

export function saleMonitorWindowOpen(dataRoot: string, owner = process.env.BLACKCAT_CHROME_OWNER_PID): boolean {
  // Standalone web/dev servers have no Electron window lifecycle.
  if (!owner) return true;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "sale-monitor-window.json"), "utf8"));
    return state.ownerPid === Number(owner) && state.open === true;
  } catch { return false; }
}
