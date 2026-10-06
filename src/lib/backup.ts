import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { getRequiredSettings } from "./settings";
import type { AppSettingsData } from "./types";
import { recordBackupHealth } from "./backupHealth";

// Make a CONSISTENT SQLite backup and prune to retention. `VACUUM INTO` writes the
// current committed state (incl. WAL) into one clean file, so it's safe even while the
// app is running. Best-effort: never throws into the caller (B7).
//
// Without this, the backupsPath/backupRetention settings + the Settings UI control are
// dead (nothing ever wrote a backup) and a corrupted DB loses all inventory + history.
async function performBackup(reason: string): Promise<string | null> {
  if (process.env.BLACKCAT_PREVIEW === '1' || process.env.NEXT_PHASE === 'phase-production-build') return null;
  let settings:AppSettingsData|undefined;
  try {
    settings = await getRequiredSettings();
    const dir = settings.backupsPath;
    if (!dir) return null;
    const retention = Math.max(1, settings.backupRetention ?? 20);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(dir, `black-cat-${stamp}.db`);
    // SQLite path literal — escape single quotes; forward slashes are fine on Windows.
    const safe = dest.replace(/\\/g, "/").replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${safe}'`);

    // Prune oldest beyond retention (timestamped names sort chronologically).
    const files = fs.readdirSync(dir).filter((f) => /^black-cat-.*\.db$/.test(f)).sort();
    for (let i = 0; i < files.length - retention; i++) {
      try { fs.rmSync(path.join(dir, files[i]), { force: true }); } catch { /* ignore */ }
    }
    console.log(`[backup] wrote ${path.basename(dest)} (${reason}); retention ${retention}`);
    try { recordBackupHealth(settings.dataRoot, { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null, fileName: path.basename(dest), reason }); } catch { /* Backup itself succeeded. */ }
    return dest;
  } catch (e) {
    try { if(settings)recordBackupHealth(settings.dataRoot, { lastAttemptAt: new Date().toISOString(), lastError: "Backup failed. Check folder access and available disk space.", reason }); } catch { /* The server log still records the failure. */ }
    console.warn(`[backup] failed (${reason}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const key = Symbol.for("blackcat.backupInFlight");
const shared = globalThis as unknown as Record<symbol, Promise<string | null> | undefined>;
export function backupDatabase(reason: string): Promise<string | null> {
  if (!shared[key]) shared[key] = performBackup(reason).finally(() => { delete shared[key]; });
  return shared[key]!;
}
