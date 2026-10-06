// Shared types across the Next.js app and the worker IPC boundary.

export interface AppSettingsData {
  dataRoot: string;
  incomingPath: string;
  processingPath: string;
  readyPath: string;
  needsReviewPath: string;
  archivePath: string;
  exportsPath: string;
  logsPath: string;
  backupsPath: string;
  pythonWorkerPath: string;
  skuPrefixes: string[];
  skuLength: number;
  skuRegex: string;
  requiredFieldsForReady: string[];
  minListingPhotos: number;
  fileStabilitySeconds: number;
  ocrEnabled: boolean;
  ocrPreprocess: boolean;
  ocrPostCorrect: boolean;
  // Only OCR a photo when a QR-like pattern was detected but not decoded (a damaged
  // sticker). Without the gate, CPU OCR runs on every garment photo (~14s each).
  ocrSmartGate: boolean;
  // Clothing-tag OCR: a second, separate use of the same CPU-pinned PaddleOCR.
  // The SKU cascade above reads sticker cards; this reads neck/care/waist tags
  // for brand, size, style number, fabric and country, and hands what it read to
  // the vision model as evidence to check itself against.
  tagOcrEnabled: boolean;
  tagOcrMaxPhotos: number;
  tagOcrMinConfidence: number;
  // Market Intelligence. Its own section, and its own switches: research must never
  // be able to interrupt intake, review or an upload run.
  // Off by default. A refresh recomputes LOCAL aggregates -- it polls no marketplace.
  backupRetention: number;
  statusColors: Record<string, string>;
  // Local AI attribute detection (size / color+pattern / item type+category / brand).
  // Model identity, endpoint selection, and process lifecycle are fixed by the
  // tracked local-runtime manifest. App settings expose no transport or eviction knobs.
  visionEnabled: boolean;
  visionMaxPhotos: number;    // 1..4 images sent per item
  visionFields: string[];     // which fields to auto-fill: size|color|pattern|itemType|brand
  visionTimeoutSeconds: number;
  // Per-item generation budget. The managed helper disables thinking; this still
  // leaves enough room for the complete structured answer.
  visionMaxTokens: number;    // 128..1800 generated tokens per item
  // Assisted-upload finalize behavior (persisted toggles on the Ready page).
  // draftMode=true  -> after filling, click "Save as Draft" (safe default).
  // draftMode=false -> after filling, click Publish/Post (live listing).
  // autoMode=true -> the Ready page can run Assist Upload over every ready item,
  // one at a time (the user still presses Start; never auto-fires on load).
  // Circuit breaker (§37.2): abort an auto run after N CONSECUTIVE failures with zero
  // successes in between — that pattern means Nifty itself is broken (UI change, dead
  // session), not the items. Isolated failures never trip it. 0 = off.
  publishAbortAfterConsecutiveFailures: number;
  // Pricing-table conventions: whole-number entries become .99 prices ("down": 25 -> 24.99,
  // "up": 25 -> 25.99, "off": saved as typed). Decimals are always kept as typed.
  priceNinetyNine: "down" | "up" | "off";
  // Typo guard: a price outside [min, max] needs a second Enter to confirm.
  priceWarnMin: number;
  priceWarnMax: number;
  // One-click Google Lens: uploads the photo to a TEMPORARY public host (auto-deletes in
  // ~1 hour) so Lens can fetch it, then opens results directly. ON by default — product
  // photos become public at listing time anyway (user decision 2026-07-02). Off = private
  // copy-to-clipboard + paste flow instead.
  lensPublicUpload: boolean;
  // depopBoost=true -> the assist enables Depop's paid "Boost your listing" toggle.
  // A paid promotion, so it's user-controlled (default on to preserve prior behavior).
  // Nifty -> BCA sync (reads YOUR logged-in Inventory Manager; marks Sold/Removed).
  // Earnings money model (§30.3). Marketplace fee = salePrice * feePercent/100 + fixedFee,
  // keyed by platform; "default" is used when the platform sold on is unknown. Used to
  // ESTIMATE fees when Nifty doesn't expose the actual (feesEstimated=true on the item).
  feeModel: Record<string, { feePercent: number; fixedFee: number }>;
  // Shipping-label cost estimate: the first tier whose maxOz >= the item's weight wins;
  // anything heavier than the top tier uses `default`.
  shippingModel: { tiers: { maxOz: number; cost: number }[]; default: number };
  // Mercari ship-from address the assist SELECTS on the operator's own Mercari account
  // (it must match an address already saved there; the worker never types a new one).
  // Per-machine — this is what lets someone other than Drew run the uploader.
  mercariShipFrom: { city: string; zip: string; state: string; stateFull: string };
  // First-run guide (/setup). Steps nothing local can observe — an eBay shipping policy
  // lives in someone else's account — are ticked off by hand and remembered here.
  setupAcknowledged?: string[];
  // The operator closed the dashboard's setup banner. The guide itself stays reachable.
  setupGuideDismissed?: boolean;
  lastSyncAt?: string;         // ISO timestamp of the last sync (runtime state)
  lastSyncSummary?: string;    // human summary of the last sync result
  // Direct marketplace publishing (§45). OPTIONAL on purpose: absent = feature not
  // configured, and defaults.json (shared with the Python worker) needs no entry.
  publish?: PublishSettings;
}

// ---------------------------------------------------------------------------
// Direct marketplace publishing settings (§45.17, §45.23).
//
// Per-marketplace credentials live in their own sub-object so authentication is
// isolated per provider. No raw marketplace passwords are ever stored — eBay uses
// OAuth (the stored refreshToken is revocable from the eBay account at any time),
// and Depop has no credential storage at all (assisted browser, user logs in).
// ---------------------------------------------------------------------------

export interface EbayPublishConfig {
  enabled: boolean;
  /// sandbox = api.sandbox.ebay.com (safe testing); production = real listings.
  env: "sandbox" | "production";
  /// Developer keyset (developer.ebay.com). Identifies the APP, not the account.
  clientId: string;
  clientSecret: string;
  /// eBay's OAuth redirect name ("RuName") from the same keyset page.
  ruName: string;
  /// Stored after the one-time consent flow; exchanged for access tokens per run.
  refreshToken?: string;
  /// ISO expiry of the refresh token, so the UI can warn before it dies (~18 months).
  refreshTokenExpiresAt?: string;
  /// Business-policy IDs from the seller account (§45.13: never hardcoded).
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  /// Inventory-location key (Account API); required by publishOffer.
  merchantLocationKey?: string;
}

export interface PublishSettings {
  relistPricing?: "reviewed" | "preserve_marketplace";
  autoRun?: { enabled: boolean; marketplaces: string[]; lastRunId?: number; pausedRunId?: number | null };
  /// Local browser sale checks and verified removal of other direct listings.
  /// Defaults off while marketplace rollout is being verified.
  saleMonitorEnabled?: boolean;
  /// Delay after a completed sale-check cycle, in whole minutes (2–1440).
  saleMonitorIntervalMinutes?: number;
  /// Daily target (1–720), spread over 24 hours. Null uses the whole-minute delay.
  saleMonitorChecksPerDay?: number | null;
  /// Operator-confirmed completed sales; reaching the goal never unlocks posting by itself.
  mercariListingLimit?: { blocked: boolean; confirmedSaleSkus: string[] };
  /// Legacy stored configuration only. All registered marketplaces use browser
  /// posting and the old authorization route is retired. Retain existing values
  /// for data compatibility; do not reactivate the API transport.
  ebay?: EbayPublishConfig;
  /// Depop assisted-browser posting. autoPost=false runs fill-first mode: the
  /// worker fills the sell form and STOPS so the operator presses Post — the
  /// proving mode for a new machine or a changed Depop UI. Default true.
  depop?: { enabled: boolean; autoPost?: boolean; unlistedBrands?: string[]; boostListings?: boolean };
  /// Native Poshmark browser posting. Off unless explicitly enabled. autoPost=false
  /// verifies the final review screen and closes without publishing.
  poshmark?: { enabled: boolean; autoPost?: boolean };
  mercari?: { enabled: boolean; autoPost?: boolean; unlistedBrands?: string[]; unisexDepartment: "Men" | "Women"; shippingMode: "buyer_label" | "ship_on_own" };
  /// Native Etsy posting uses the seller account in the user's open Chrome.
  etsy?: { enabled: boolean; autoPost?: boolean; shippingProfileName: string; autoRenew?: boolean };
  /// Browser-only eBay path; independent of the dormant API configuration above.
  ebayBrowser?: { enabled: boolean; autoPost?: boolean; shippingPolicyName?: string; returnPolicyName?: string; paymentPolicyName?: string; generalAdRate?: number | null };
  /// Seconds between listings PER MARKETPLACE (§45.20). Reliability over speed.
  pacingSeconds?: number;      // default 8
  /// Attempts per job before a retryable error becomes a failure (§45.21).
  maxAttempts?: number;        // default 4
  /// Items live on Nifty (Draft/Published) are BLOCKED from direct publishing by
  /// default — Nifty already crosslists them, so a direct publish would duplicate
  /// the listing on the marketplace itself. true = operator accepts that risk.
  allowNiftyOverlap?: boolean; // default false
}

// Local-vision settings contract. Transport and process controls are intentionally
// absent: only bounded behavior may cross the app settings boundary. Keeping
// this policy dependency-free makes forged legacy-row regression tests pure.
export const LOCAL_VISION_MAX_PHOTOS = 4;
export const LOCAL_VISION_MAX_OUTPUT_TOKENS = 1800;

export const MANAGED_VISION_SETTING_KEYS = [
  "visionEnabled",
  "visionMaxPhotos",
  "visionFields",
  "visionTimeoutSeconds",
  "visionMaxTokens",
] as const;

const MANAGED_VISION_SETTING_KEY_SET = new Set<string>(MANAGED_VISION_SETTING_KEYS);

export function retiredVisionSettingKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => key.startsWith("vision") && !MANAGED_VISION_SETTING_KEY_SET.has(key));
}

export function stripRetiredVisionSettings(value: unknown): Partial<AppSettingsData> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cleaned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of retiredVisionSettingKeys(cleaned)) delete cleaned[key];
  return cleaned as Partial<AppSettingsData>;
}

// Settings that no longer exist anywhere in the code but may still sit in an
// older stored row. Kept separate from the vision retirement above: that one is
// a boundary that rejects arbitrary transport controls, this one is plain
// housekeeping. `ocrEngine` is the live example — a stored row still carries
// "paddleocr-ppocrv5-gpu" while decode.py pins every PaddleOCR constructor to
// device="cpu" on purpose (see worker/requirements.txt for why). Nothing reads
// the key, so its only effect is to tell anyone who opens the settings that OCR
// runs on the GPU. Strip it rather than leave a value that contradicts the code.
export const RETIRED_SETTING_KEYS = ["ocrEngine", "marketEnabled", "marketAutoRefreshEnabled", "marketRefreshIntervalHours", "niftyUploadUrl", "niftySelectors", "draftMode", "autoMode", "depopBoost", "niftyInventoryUrl", "syncEnabled", "syncIntervalHours"] as const;

const RETIRED_SETTING_KEY_SET = new Set<string>(RETIRED_SETTING_KEYS);

export function retiredSettingKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => RETIRED_SETTING_KEY_SET.has(key));
}

export function stripRetiredSettings(value: unknown): Partial<AppSettingsData> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cleaned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of retiredSettingKeys(cleaned)) delete cleaned[key];
  return cleaned as Partial<AppSettingsData>;
}

export type ProcessIntent =
  | { ok: true; forceNoAi: boolean }
  | { ok: false; error: string };

/** Strict request intent: truthy strings/numbers must never bypass managed AI. */
export function parseProcessIntent(value: unknown): ProcessIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "process request must be a JSON object" };
  }
  const body = value as Record<string, unknown>;
  if ("force" in body && typeof body.force !== "boolean") {
    return { ok: false, error: "force must be true or false" };
  }
  return { ok: true, forceNoAi: body.force === true };
}

// Per-item enrichment the worker emits and persist.ts applies.
export interface ItemEnrichment {
  fields?: Partial<Record<"size" | "color" | "pattern" | "itemType" | "category" | "brand", string>>;
  aiFields?: string[];
  raw?: unknown;
  // Why AI identification produced nothing for this item — persisted to
  // Item.aiError and surfaced in Review + the batch problem log (the fix for the
  // 2026-08-05 silent blank batch). One failed item never stops the batch.
  error?: string;
  /** Explicit operator-requested no-AI result; never a blank-success fallback. */
  skipped?: boolean;
  /** Optional stronger audit label accepted from managed worker fixtures. */
  intentional?: boolean;
}

// ---- Worker result payload (must mirror worker/black_cat_worker/process.py) ----

export interface WorkerPhoto {
  originalFilename: string;
  storedPath: string;
  thumbPath: string | null;
  sha256: string | null;
  sortOrder: number;
  isCover: boolean;
  isMarker: boolean;
  includeInListing: boolean;
  rotation: number;
  decodedValue: string | null;
  decodeMethod: string | null;
  width: number | null;
  height: number | null;
  exifDateTimeOriginal: string | null;
  exifSubSec: string | null;
}

// Why-these-photos-grouped audit the worker attaches to every item (v1.2).
export interface ItemGrouping {
  confidence: "high" | "medium" | "low";
  reasons: string[];
  closedBy: "qr-marker" | "ocr-marker" | "unreadable-sticker" | "recovered-sticker" | "end-of-batch";
  orderSource: "exif" | "filename" | "filename-mixed";
  log: {
    file: string;
    role: string;
    time: string | null;
    gapBeforeSec: number | null;
    decode: string | null;
    raw: string | null;
  }[];
}

export interface WorkerItem {
  sku: string;
  originalQrValue: string | null;
  processingFolderPath: string;
  photos: WorkerPhoto[];
  enrichment: ItemEnrichment;
  grouping?: ItemGrouping;
  // Shell created from an unreadable/missing SKU sticker (synthetic FIX-xxxx SKU).
  placeholder?: boolean;
  // Absolute /incoming source paths for this group (attached members + marker). Node
  // archives them to /archive/{batchId} ONLY after the item's DB commit succeeds, so a
  // crashed run leaves un-persisted originals in /incoming for a clean resume.
  originalPaths: string[];
}

export interface WorkerProblem {
  type: string;
  sku?: string | null;
  photoPath?: string | null;
  message?: string;
}

export interface WorkerResult {
  batchId: string;
  items: WorkerItem[];
  collisions: WorkerItem[];
  duplicates: { originalFilename: string; sha256: string }[];
  needsReview: { originalFilename: string; storedPath: string; reason: string }[];
  problems: WorkerProblem[];
  counts: {
    itemsCreated: number;
    photosProcessed: number;
    duplicatesSkipped: number;
    problems: number;
    collisions: number;
  };
  durationMs: number;
}

// Stored states, including historical aliases; display labels are derived separately.
export const ITEM_STATUSES = [
  "Photographed",
  "Needs Info",
  "Ready",
  "Ready for Nifty",
  "Uploaded to Nifty",
  "Listed",
  "Sold",
  "Problem",
  "Archived",
  "Removed",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
