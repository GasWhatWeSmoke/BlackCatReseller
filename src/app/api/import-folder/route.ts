import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "@/lib/settings";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";
import { acquireIntakeLease } from "@/lib/intakeJobStore";
import { recordImportedPhoto } from "@/lib/importManifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMG_RE = /\.(jpe?g)$/i;

// Recursively collect image files in a folder (depth-limited so we never wander far).
function collectImages(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 4) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectImages(full, depth + 1, acc);
    else if (e.isFile() && IMG_RE.test(e.name)) acc.push(full);
  }
  return acc;
}

// Copy every JPEG from a folder PATH into /incoming (desktop-native — no byte upload,
// so it handles huge folders reliably). The renderer gets the path from the native
// folder picker (window.blackcat.pickFolder).
export async function POST(req: NextRequest) {
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false, imported: 0,
    code: "INCOMING_BUSY", error: "Another photo import or processing run is active. Wait for it to finish before importing." }, { status: 409 });
  let release: (() => void) | undefined;
  try {
    release = acquireIntakeLease(await getSettings(), "folder-import");
    return await importFolder(req);
  } catch (error) {
    if (error instanceof Error && error.message === "INTAKE_BUSY") return NextResponse.json({ ok: false, imported: 0,
      code: "INCOMING_BUSY", error: "Photo processing is active in another application process." }, { status: 409 });
    throw error;
  } finally { release?.(); releaseIncomingMutation(); }
}

async function importFolder(req: NextRequest) {
  let folderPath = "";
  try {
    const body = await req.json();
    folderPath = typeof body.folderPath === "string" ? body.folderPath : "";
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request (no folderPath)." }, { status: 400 });
  }

  console.log(`[import-folder] requested folder: ${folderPath || "(empty)"}`);
  if (!folderPath) {
    return NextResponse.json({ ok: false, error: "No folder selected." }, { status: 400 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    console.error(`[import-folder] folder not found: ${folderPath}`);
    return NextResponse.json({ ok: false, error: `Folder not found:\n${folderPath}` }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ ok: false, error: "That path is not a folder." }, { status: 400 });
  }

  const images = collectImages(folderPath);
  console.log(`[import-folder] found ${images.length} JPEG(s) in ${folderPath}`);
  if (!images.length) {
    return NextResponse.json(
      { ok: false, error: "No JPEG images found in that folder (Black Cat uses .jpg/.jpeg)." },
      { status: 422 },
    );
  }

  const settings = await getSettings();
  try {
    fs.mkdirSync(settings.incomingPath, { recursive: true });
  } catch (e) {
    console.error(`[import-folder] cannot create incoming dir ${settings.incomingPath}:`, e);
    return NextResponse.json(
      { ok: false, error: `Could not write to the incoming folder:\n${settings.incomingPath}` },
      { status: 500 },
    );
  }

  let imported = 0;
  const failed: string[] = [];
  const metadataWarnings: string[] = [];
  for (const src of images) {
    const ext = path.extname(src);
    const stem = path.basename(src, ext);
    try {
      for (let suffix = 0; ; suffix++) {
        const dest = path.join(settings.incomingPath, suffix ? `${stem}__${suffix}${ext}` : path.basename(src));
        try {
          await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
          const saved = fs.openSync(dest, "r+");
          try { fs.fsyncSync(saved); } finally { fs.closeSync(saved); }
          try {
            recordImportedPhoto(settings.dataRoot, { storedPath: dest, originalFilename: path.basename(src),
              sourcePath: src, sourceRelativePath: path.relative(folderPath, src) });
          } catch { metadataWarnings.push(path.basename(src)); }
          break;
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      }
      imported++;
    } catch (e) {
      failed.push(path.basename(src));
      console.error(`[import-folder] failed to copy ${src}:`, e);
    }
  }

  console.log(`[import-folder] imported ${imported}/${images.length} into ${settings.incomingPath}` +
    (failed.length ? ` (${failed.length} failed)` : ""));
  return NextResponse.json({
    ok: imported > 0,
    imported,
    found: images.length,
    failed: failed.length,
    failedFiles: failed,
    metadataWarnings,
    incoming: settings.incomingPath,
    error: imported === 0 ? "No photos could be copied (check folder permissions)." : undefined,
  });
}
