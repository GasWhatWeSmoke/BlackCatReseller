import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getRequiredSettings, retiredVisionSettingKeys, saveSettings } from "@/lib/settings";
import {
  LOCAL_VISION_MAX_OUTPUT_TOKENS,
  LOCAL_VISION_MAX_PHOTOS,
} from "@/lib/types";
import { InvalidManagedWorkRootsError } from "@/lib/workRoots";
import { tryReserveIncomingMutation,releaseIncomingMutation } from '@/lib/worker';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Managed folder roots + the worker binary. The photo/thumb routes validate every served
// file against these roots ASSUMING they are absolute — so a relative path saved here would
// silently weaken that check (§42). Reject them at the door instead.
const PATH_KEYS = [
  "dataRoot", "incomingPath", "processingPath", "readyPath", "needsReviewPath",
  "archivePath", "exportsPath", "logsPath", "backupsPath", "pythonWorkerPath",
] as const;
const VISION_FIELDS = new Set(["size", "color", "pattern", "itemType", "brand"]);

function boundedInteger(
  patch: Record<string, unknown>, key: string, minimum: number, maximum: number,
): string | null {
  if (!(key in patch)) return null;
  const value = patch[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return `${key}: must be an integer from ${minimum} to ${maximum}`;
  }
  return null;
}

function validatePatch(patch: Record<string, unknown>): string | null {
  const retiredVision = retiredVisionSettingKeys(patch);
  if (retiredVision.length) {
    return `AI vision transport is fixed to the local runtime; retired setting(s) are not accepted: ${retiredVision.join(", ")}`;
  }
  if ("visionEnabled" in patch && typeof patch.visionEnabled !== "boolean") {
    return "visionEnabled: must be true or false";
  }
  const boundedVision = boundedInteger(patch, "visionMaxPhotos", 1, LOCAL_VISION_MAX_PHOTOS) ??
    boundedInteger(patch, "visionTimeoutSeconds", 10, 900) ??
    boundedInteger(patch, "visionMaxTokens", 128, LOCAL_VISION_MAX_OUTPUT_TOKENS);
  if (boundedVision) return boundedVision;
  if ("visionFields" in patch) {
    const fields = patch.visionFields;
    if (!Array.isArray(fields) || fields.length === 0 ||
        fields.some((field) => typeof field !== "string" || !VISION_FIELDS.has(field))) {
      return "visionFields: select at least one supported AI field (or disable AI vision)";
    }
    if (new Set(fields).size !== fields.length) return "visionFields: duplicate fields are not allowed";
  }
  for (const k of PATH_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (typeof v !== "string" || !v.trim()) return `${k}: must be a non-empty path`;
    if (!path.isAbsolute(v.trim())) return `${k}: must be an ABSOLUTE path (got "${v}")`;
  }
  // The worker path must at least look like a Python interpreter — a wrong exe here would
  // be spawned with worker arguments on the next Process/upload run.
  if (typeof patch.pythonWorkerPath === "string") {
    const base = path.basename(patch.pythonWorkerPath.trim()).toLowerCase();
    if (!/^python(\d(\.\d+)?)?(w)?(\.exe)?$/.test(base)) {
      return `pythonWorkerPath: must point to a Python interpreter (python.exe), got "${base}"`;
    }
  }
  return null;
}

export async function GET() {
  try { return NextResponse.json({ settings: await getRequiredSettings() }); }
  catch { return NextResponse.json({ error: "Saved settings are unavailable. Retry loading settings before making changes." }, { status: 503 }); }
}

export async function PUT(req: NextRequest) {
  const patch: unknown = await req.json().catch(() => null);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "settings patch must be a JSON object" }, { status: 400 });
  }
  const bad = validatePatch(patch as Record<string, unknown>);
  if (bad) return NextResponse.json({ error: bad }, { status: 422 });
  const changesPaths=PATH_KEYS.some(key=>Object.hasOwn(patch,key));
  if(changesPaths&&!tryReserveIncomingMutation())return NextResponse.json({error:'Photo operations are active. Wait for them to finish before changing folder paths.'},{status:409});
  try {
    const settings = await saveSettings(patch as Partial<Awaited<ReturnType<typeof getRequiredSettings>>>);
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof InvalidManagedWorkRootsError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
    }
    throw error;
  } finally { if(changesPaths)releaseIncomingMutation(); }
}
