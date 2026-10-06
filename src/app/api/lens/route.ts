import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRequiredSettings } from "@/lib/settings";
import { readLensPhoto, prepareLensPhoto } from "@/lib/lensPhoto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-click Google Lens (settings.lensPublicUpload): upload ONE photo to a temporary
// public host so Lens can fetch it, return the ready-to-open Lens URL.
//  - Host: litterbox.catbox.moe — anonymous, single POST, file AUTO-DELETES after 1 hour
//    (just long enough for a Lens lookup; nothing is permanently published).
//  - Input is an Item ID (the CURRENT cover is resolved here, fresh from the DB — a stale
//    client row can't send an old cover) or a Photo ID; never a raw path.
//  - The photo is downscaled to ≤1280px JPEG before upload: a phone photo is 3–12 MB and
//    made both the upload and Google's fetch slow/flaky; ~200 KB is fast and reliable.
//  - Uploads are cached per photo for 50 min (under the 1h deletion), so a re-click is instant.

const lensCache = new Map<number, { revision: string; url: string; lensUrl: string; expires: number }>();
const CACHE_TTL_MS = 50 * 60 * 1000;

async function uploadTemp(bytes: Buffer, name: string): Promise<string> {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "1h"); // auto-delete after one hour
  form.append("fileToUpload", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), name);
  const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const url = (await res.text()).trim();
  if (!res.ok || !/^https:\/\//.test(url)) {
    throw new Error(url.slice(0, 120) || `upload failed (${res.status})`);
  }
  return url;
}

export async function POST(req: NextRequest) {
  let settings: Awaited<ReturnType<typeof getRequiredSettings>>;
  try { settings = await getRequiredSettings(); }
  catch { return NextResponse.json({ ok: false, error: "Saved settings could not be read. Fix the settings error before using public Lens uploads." }, { status: 503 }); }
  if (!settings.lensPublicUpload) {
    return NextResponse.json(
      { ok: false, disabled: true, error: "One-click Lens is off (Settings → Pricing)." },
      { status: 403 },
    );
  }
  let itemId = 0;
  let photoId = 0;
  try {
    const body = await req.json();
    itemId = Number(body?.itemId) || 0;
    photoId = Number(body?.photoId) || 0;
  } catch { /* fall through to validation */ }

  if ((itemId > 0 && !Number.isSafeInteger(itemId)) || (photoId > 0 && !Number.isSafeInteger(photoId)) || (itemId <= 0 && photoId <= 0)) {
    return NextResponse.json({ ok: false, error: "A valid itemId or photoId is required" }, { status: 400 });
  }
  // Prefer itemId: the cover is looked up NOW, so a cover change moments ago is honored.
  const photo = itemId > 0
    ? await prisma.photo.findFirst({
        where: { itemId, isMarker: false },
        orderBy: [{ isCover: "desc" }, { sortOrder: "asc" }],
      })
    : photoId > 0
      ? await prisma.photo.findUnique({ where: { id: photoId } })
      : null;
  if (!photo || !photo.storedPath) {
    return NextResponse.json({ ok: false, error: "photo not found" }, { status: 404 });
  }

  try {
    const t0 = Date.now();
    let prepared;
    try { prepared = readLensPhoto(photo, settings); }
    catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "This photo could not be read safely." }, { status: 422 }); }
    const cached = lensCache.get(photo.id);
    if (cached && cached.revision === prepared.revision && cached.expires > Date.now()) {
      return NextResponse.json({ ok: true, url: cached.url, lensUrl: cached.lensUrl, cached: true });
    }
    let bytes: Buffer;
    try { bytes = await prepareLensPhoto(prepared.raw, prepared.rotation); }
    catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "This photo could not be prepared safely." }, { status: 422 }); }
    const name = `lens-${photo.id}.jpg`;
    let url: string;
    try {
      url = await uploadTemp(bytes, name);
    } catch {
      url = await uploadTemp(bytes, name); // one retry — litterbox hiccups happen
    }
    const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`;
    lensCache.set(photo.id, { revision: prepared.revision, url, lensUrl, expires: Date.now() + CACHE_TTL_MS });
    console.log(`[lens] photo ${photo.id}: ${(prepared.raw.length / 1024) | 0}KB → ${(bytes.length / 1024) | 0}KB, uploaded in ${Date.now() - t0}ms (1h temp)`);
    return NextResponse.json({ ok: true, url, lensUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `temp upload failed: ${msg}` }, { status: 502 });
  }
}
