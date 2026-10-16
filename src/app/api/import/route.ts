import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { validImportPhotoName, writeIncomingPhoto } from "@/lib/importPhoto";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";
import { acquireIntakeLease } from "@/lib/intakeJobStore";
import { recordImportedPhoto } from "@/lib/importManifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives dropped/selected JPEGs and writes them into /incoming.
export async function POST(req: NextRequest) {
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false, imported: 0,
    code: "INCOMING_BUSY", error: "Another photo import or processing run is active. Wait for it to finish before importing." }, { status: 409 });
  let release: (() => void) | undefined;
  try {
    release = acquireIntakeLease(await getSettings(), "photo-import");
    return await importPhotos(req);
  } catch (error) {
    if (error instanceof Error && error.message === "INTAKE_BUSY") return NextResponse.json({ ok: false, imported: 0,
      code: "INCOMING_BUSY", error: "Photo processing is active in another application process." }, { status: 409 });
    throw error;
  } finally { release?.(); releaseIncomingMutation(); }
}

async function importPhotos(req: NextRequest) {
  const settings = await getSettings();
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ ok: false, imported: 0, error: "The photo upload could not be read. Try selecting the files again." }, { status: 400 }); }
  const files = form.getAll("files");
  const relativePaths = form.getAll("sourceRelativePaths");
  let imported = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  const metadataWarnings: string[] = [];

  for (const [index, f] of files.entries()) {
    if (!(f instanceof File)) continue;
    if (!validImportPhotoName(f.name)) {
      skipped.push(f.name);
      continue;
    }
    try {
      const storedPath = await writeIncomingPhoto(settings.incomingPath, f.name, new Uint8Array(await f.arrayBuffer()));
      try {
        const relative = relativePaths[index];
        recordImportedPhoto(settings.dataRoot, { storedPath, originalFilename: f.name,
          ...(typeof relative === "string" && relative.length <= 2048 ? { sourceRelativePath: relative } : {}) });
      } catch { metadataWarnings.push(f.name); }
      imported++;
    } catch { failed.push(f.name); }
  }
  return NextResponse.json({ ok: imported > 0, imported, skipped, failed, metadataWarnings,
    ...(!imported ? { error: "No photos were imported. Select JPEG files with plain filenames and check folder access." } : {}) },
    { status: imported > 0 ? 200 : 422 });
}
