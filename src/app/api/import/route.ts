import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { validImportPhotoName, writeIncomingPhoto } from "@/lib/importPhoto";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives dropped/selected JPEGs and writes them into /incoming.
export async function POST(req: NextRequest) {
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false, imported: 0,
    code: "INCOMING_BUSY", error: "Another photo import or processing run is active. Wait for it to finish before importing." }, { status: 409 });
  try { return await importPhotos(req); }
  finally { releaseIncomingMutation(); }
}

async function importPhotos(req: NextRequest) {
  const settings = await getSettings();
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ ok: false, imported: 0, error: "The photo upload could not be read. Try selecting the files again." }, { status: 400 }); }
  const files = form.getAll("files");
  let imported = 0;
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const f of files) {
    if (!(f instanceof File)) continue;
    if (!validImportPhotoName(f.name)) {
      skipped.push(f.name);
      continue;
    }
    try {
      await writeIncomingPhoto(settings.incomingPath, f.name, new Uint8Array(await f.arrayBuffer()));
      imported++;
    } catch { failed.push(f.name); }
  }
  return NextResponse.json({ ok: imported > 0, imported, skipped, failed,
    ...(!imported ? { error: "No photos were imported. Select JPEG files with plain filenames and check folder access." } : {}) },
    { status: imported > 0 ? 200 : 422 });
}
