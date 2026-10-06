import fs from "node:fs";
import path from "node:path";
export interface BackupHealth { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string | null; fileName?: string; reason?: string }
const healthPath = (root: string) => path.join(root, "backup-health.json");
export function backupHealth(root: string): BackupHealth {
  try { const value = JSON.parse(fs.readFileSync(healthPath(root), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export function recordBackupHealth(root: string, update: BackupHealth) {
  fs.mkdirSync(root, { recursive: true });
  const file = healthPath(root), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...backupHealth(root), ...update }), "utf8"); fs.renameSync(temporary, file);
}
export function backupFiles(folder: string) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^black-cat-.*\.db$/.test(entry.name)).map(entry => {
    const stat = fs.statSync(path.join(folder, entry.name));
    return { name: entry.name, size: stat.size, createdAt: stat.mtime.toISOString() };
  }).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
