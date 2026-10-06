import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "@/lib/settings";
import { tryReserveIncomingMutation, releaseIncomingMutation } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discard the PENDING import: delete the files sitting in /incoming that no Process run
// has consumed (e.g. the user dropped the wrong photos and killed the run). Safe-ish by
// design — /incoming holds COPIES made at import time; the user's source files are
// untouched, so a discarded batch can simply be re-dropped. Files only, top level only
// (Process never leaves subdirectories in /incoming). Confirmation is enforced in the UI.
export async function POST() {
  if (!tryReserveIncomingMutation()) return NextResponse.json({ ok: false, removed: 0,
    code: "INCOMING_BUSY", error: "A photo import or processing run is active. Wait for it to finish before discarding pending photos." }, { status: 409 });
  try { return await discardIncoming(); }
  finally { releaseIncomingMutation(); }
}

async function discardIncoming() {
  const s = await getSettings();
  const dir = s.incomingPath;
  try {
    if (!fs.existsSync(dir)) {
      return NextResponse.json({ ok: true, removed: 0 });
    }
    let removed = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        fs.rmSync(path.join(dir, entry.name), { force: true });
        removed += 1;
      } catch (e) {
        console.error(`[maintenance] could not remove incoming file ${entry.name}:`, e);
      }
    }
    console.log(`[maintenance] cleared /incoming — discarded ${removed} pending file(s) from ${dir}`);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[maintenance] clear-incoming failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
