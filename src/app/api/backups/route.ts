import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRequiredSettings } from "@/lib/settings";
import { backupDatabase } from "@/lib/backup";
import { backupHealth, backupFiles } from "@/lib/backupHealth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { const settings = await getRequiredSettings(); const files = backupFiles(settings.backupsPath); return NextResponse.json({ health: backupHealth(settings.dataRoot), latest: files[0] ?? null, count: files.length }); }
  catch { return NextResponse.json({ error: "Backup settings or folder could not be read. Check the saved location and retry." }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body?.action === "create") {
    const file = await backupDatabase("manual");
    return file ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Backup did not complete. Check folder access and available disk space." }, { status: 500 });
  }
  if (body?.action !== "verify") return NextResponse.json({ error: "Choose create or verify." }, { status: 400 });
  try {
    const settings = await getRequiredSettings();
    const latest = backupFiles(settings.backupsPath)[0];
    if (!latest) return NextResponse.json({ error: "Create a backup first." }, { status: 409 });
    const { stdout } = await promisify(execFile)(settings.pythonWorkerPath, ["-m", "black_cat_worker.verify_backup", "--file", path.join(settings.backupsPath, latest.name)], {
      cwd: path.join(process.cwd(), "worker"), windowsHide: true, timeout: 120_000, maxBuffer: 100_000, env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8" },
    });
    return NextResponse.json({ ...JSON.parse(stdout.trim()), fileName: latest.name, checkedAt: new Date().toISOString() });
  } catch { return NextResponse.json({ error: "The backup-copy check could not finish. Live data was not restored or replaced." }, { status: 500 }); }
}
