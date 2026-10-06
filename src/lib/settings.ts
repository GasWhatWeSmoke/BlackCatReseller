import path from "node:path";
import { prisma } from "./db";
import type { AppSettingsData } from "./types";
import {
  LOCAL_VISION_MAX_OUTPUT_TOKENS,
  LOCAL_VISION_MAX_PHOTOS,
  retiredVisionSettingKeys,
  stripRetiredVisionSettings,
  stripRetiredSettings,
} from "./types";
import { validateManagedWorkRoots } from "./workRoots";
import { updateSettingsRow } from "./settingsStore";
export { retiredVisionSettingKeys, stripRetiredVisionSettings } from "./types";
export { retiredSettingKeys, stripRetiredSettings, RETIRED_SETTING_KEYS } from "./types";
// Single source of truth for the non-path defaults (§28). The DB seed
// (scripts/init-db.mjs) and the Python worker (config.py) read the SAME file, so the
// three can't drift. Bundled at build time, so it ships inside the compiled output.
import sharedConfig from "../../config/defaults.json";

// The static (non-path) defaults, shared verbatim with the seed + worker. The explicit
// type annotation makes `tsc` FAIL if defaults.json ever drifts from AppSettingsData
// (a missing/renamed field is caught at build time, not runtime).
const staticDefaults: Omit<
  AppSettingsData,
  | "dataRoot" | "incomingPath" | "processingPath" | "readyPath" | "needsReviewPath"
  | "archivePath" | "exportsPath" | "logsPath" | "backupsPath" | "pythonWorkerPath"
  | "lastSyncAt" | "lastSyncSummary"
> = {
  ...sharedConfig.defaults,
  // JSON imports widen string literals to `string`; re-narrow the one union-typed field.
  priceNinetyNine: sharedConfig.defaults.priceNinetyNine as AppSettingsData["priceNinetyNine"],
};

export function defaultSettings(): AppSettingsData {
  const projectRoot = process.cwd();
  const dataRoot = process.env.BLACKCAT_DATA_ROOT || path.join(projectRoot, "var");
  const j = (...p: string[]) => path.join(dataRoot, ...p);
  // Environment-derived paths are computed here (NOT in defaults.json); the static
  // policy defaults are spread in from the shared file.
  return {
    ...staticDefaults,
    dataRoot,
    incomingPath: j("incoming"),
    processingPath: j("processing"),
    readyPath: j("ready"),
    needsReviewPath: j("needs-review"),
    archivePath: j("archive"),
    exportsPath: j("exports"),
    logsPath: j("logs"),
    backupsPath: j("backups"),
    pythonWorkerPath:
      process.env.BLACKCAT_PYTHON ||
      path.join(projectRoot, "worker", ".venv", "Scripts", "python.exe"),
  };
}

// Stored rows may predate the fixed local-runtime boundary and still carry
// arbitrary sidecar controls. The dependency-free policy in types.ts removes them in
// memory immediately and durably on the next settings save.

const MANAGED_VISION_FIELDS = new Set(["size", "color", "pattern", "itemType", "brand"]);

function normalizeManagedVisionSettings(
  candidate: Partial<AppSettingsData>,
  defaults: AppSettingsData,
): Partial<AppSettingsData> {
  // Drop long-dead keys before the vision boundary runs, so a stale stored
  // row cannot keep advertising behaviour the code no longer has.
  const cleaned = stripRetiredVisionSettings(stripRetiredSettings(candidate));
  const normalized: Partial<AppSettingsData> = { ...cleaned };
  if (typeof cleaned.visionEnabled !== "boolean") normalized.visionEnabled = defaults.visionEnabled;
  const boundedInteger = (value: unknown, minimum: number, maximum: number, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
      ? value : fallback;
  normalized.visionMaxPhotos = boundedInteger(
    cleaned.visionMaxPhotos, 1, LOCAL_VISION_MAX_PHOTOS, defaults.visionMaxPhotos,
  );
  normalized.visionTimeoutSeconds = boundedInteger(
    cleaned.visionTimeoutSeconds, 10, 900, defaults.visionTimeoutSeconds,
  );
  normalized.visionMaxTokens = boundedInteger(
    cleaned.visionMaxTokens, 128, LOCAL_VISION_MAX_OUTPUT_TOKENS, defaults.visionMaxTokens,
  );
  const fields = cleaned.visionFields;
  normalized.visionFields = Array.isArray(fields) && fields.length > 0 &&
      fields.every((field) => typeof field === "string" && MANAGED_VISION_FIELDS.has(field)) &&
      new Set(fields).size === fields.length
    ? fields : defaults.visionFields;
  return normalized;
}

export async function getSettings(): Promise<AppSettingsData> {
  const defaults = defaultSettings();
  try {
    const row = await prisma.appSettings.findUnique({ where: { id: 1 } });
    if (row?.data) {
      return {
        ...defaults,
        ...normalizeManagedVisionSettings(JSON.parse(row.data), defaults),
      };
    }
  } catch {
    /* DB not ready */
  }
  return defaults;
}

export type SettingsHealthRead = {
  settings: AppSettingsData;
  ok: boolean;
  source: "configured" | "defaults" | "fallback";
  error?: "settings_malformed";
};

// Health-aware read for diagnostics/integrations that must distinguish an
// intentional default configuration from a silent malformed-settings fallback.
// Database errors deliberately propagate so the caller cannot label them healthy.
export async function getSettingsWithHealth(): Promise<SettingsHealthRead> {
  const defaults = defaultSettings();
  const row = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!row?.data) return { settings: defaults, ok: true, source: "defaults" };
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("settings payload is not an object");
    }
    return {
      settings: {
        ...defaults,
        ...normalizeManagedVisionSettings(parsed as Partial<AppSettingsData>, defaults),
      },
      ok: true,
      source: "configured",
    };
  } catch {
    return {
      settings: defaults,
      ok: false,
      source: "fallback",
      error: "settings_malformed",
    };
  }
}

/** Decisions that can make inventory publishable must use the saved configuration. */
export async function getRequiredSettings(): Promise<AppSettingsData> {
  const read = await getSettingsWithHealth();
  if (!read.ok) throw new Error("Saved settings could not be read. Fix the settings error before approving inventory.");
  return read.settings;
}

export async function saveSettings(patch: Partial<AppSettingsData>): Promise<AppSettingsData> {
  return updateSettings(() => patch);
}

export async function updateSettings(change: (current: AppSettingsData) => Partial<AppSettingsData>): Promise<AppSettingsData> {
  return updateSettingsRow(prisma, stored => {
    const defaults = defaultSettings();
    const parsed: unknown = stored === null ? {} : JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Settings need repair before they can be saved.");
    const current = { ...defaults, ...normalizeManagedVisionSettings(parsed as Partial<AppSettingsData>, defaults) };
    const merged = { ...current, ...normalizeManagedVisionSettings(change(current), current) };
    validateManagedWorkRoots(merged);
    return { data: JSON.stringify(merged), value: merged };
  });
}
