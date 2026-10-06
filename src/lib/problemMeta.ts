// Shared problem-type metadata: a friendly label + a severity tier for every
// ProblemLog `type` the worker/app can emit. Drives the Dashboard's split panels
// so real errors are never buried under advisory warnings (the 50-item run
// buried 2 real merge warnings under ~100k advisory rows).

export type ProblemSeverity = "critical" | "warning" | "info";

export interface ProblemMeta {
  label: string;
  severity: ProblemSeverity;
  hint?: string;
}

const META: Record<string, ProblemMeta> = {
  // ---- Critical: something failed and needs action -------------------------
  AI_ENRICH_FAILED: { label: "AI Identification Needed", severity: "critical", hint: "Items imported with photos but still need AI identification. If you chose no AI, this is the expected retry reminder; otherwise run Settings → Test local vision, then use Retry AI in Review." },
  VISION_UNAVAILABLE: { label: "AI Vision Unavailable", severity: "critical", hint: "The local vision runtime was unavailable, so intake stopped before changing any photos. Check Settings, retry shortly, or explicitly import without AI." },
  DECODE_ENGINE_UNAVAILABLE: { label: "QR Reading Unavailable", severity: "critical", hint: "OpenCV failed to import in the worker interpreter, so no SKU sticker can be decoded or even located — every item in the batch comes back unmarked. Run `npm run worker:setup` to reinstall the worker dependencies." },
  IMPORT_FAILED: { label: "Critical Error", severity: "critical", hint: "The item could not be saved — its originals were left in /incoming; run Process again." },
  UNREADABLE_FILE: { label: "Critical Error", severity: "critical", hint: "A file could not be read or moved — check it by hand." },
  UPLOAD_FAILED: { label: "Critical Error", severity: "critical", hint: "A publish/upload attempt failed — retry from the Ready page." },
  PUBLISH_FAILED: { label: "Critical Error", severity: "critical", hint: "A publish attempt failed — retry from the Ready page." },
  RECONCILE_NEEDED: { label: "Critical Error", severity: "critical", hint: "Nifty and the app disagree about this item's status." },
  SOLD_STILL_LISTED: { label: "Sold but Still Listed", severity: "critical", hint: "This item sold, but its listing is still live on Nifty — Nifty's inventory has not caught up with its own order. End the listing on Nifty before it sells a second time." },
  LISTING_EDIT_FAILED: { label: "Listing Update Failed", severity: "critical", hint: "A push to an already-live Nifty listing could not be applied — the listing still shows its old title/price. Retry from the Listings tab, or open the listing on Nifty and edit it by hand." },
  MARKETPLACE_PUBLISH_FAILED: { label: "Not on a Marketplace", severity: "critical", hint: "Nifty listed this item everywhere except the marketplace named here (its inventory row shows a publishing error). Use “Retry Mercari failures” on Past Uploads, or open Nifty, click the cover photo, and press Retry." },
  MARKETPLACE_LIST_FAILED: { label: "Marketplace Listing Failed", severity: "critical", hint: "Pressing Nifty's own List/Retry for this marketplace did not go through — the message says what Nifty still wanted." },

  // ---- Warnings: the batch imported, but review these ----------------------
  DECODE_FALLBACK_UNAVAILABLE: { label: "QR Fallback Unavailable", severity: "warning", hint: "pyzbar and/or PaddleOCR failed to import, so a sticker whose QR is damaged or glare-hit has no second chance at being read. Run `npm run worker:setup` to reinstall the worker dependencies." },
  RECOVERED_SKU: { label: "Needs Review", severity: "warning", hint: "A sticker couldn't be read, so the item was created automatically with the missing sequence number — verify its photos and number." },
  UNREADABLE_STICKER: { label: "Needs Review", severity: "warning", hint: "A SKU sticker was photographed but could not be read — a FIX-xxxx shell item holds its photos; assign the right SKU." },
  UNTERMINATED_GROUP: { label: "Needs Review", severity: "warning", hint: "Photos at the end of the batch had no SKU sticker — they were kept as a shell item." },
  MISSING_SKU: { label: "Grouping Uncertain", severity: "warning", hint: "A SKU number is absent from the batch — its photos may have merged into the next item; use Split." },
  GROUPING_UNCERTAIN: { label: "Grouping Uncertain", severity: "warning", hint: "A long pause inside one item's photos — double-check it isn't two items." },
  MERGED_GROUP_SUSPECTED: { label: "Grouping Uncertain", severity: "warning", hint: "This item has far more photos than the batch norm." },
  AMBIGUOUS_MARKER: { label: "Possible Duplicate", severity: "warning", hint: "The same SKU was decoded twice in one batch." },
  DUPLICATE_SKU_COLLISION: { label: "Possible Duplicate", severity: "warning" },
  MARKER_NO_PHOTOS: { label: "Missing Photos", severity: "warning", hint: "A SKU sticker had no item photos before it." },
  OCR_SKU_OUTLIER: { label: "Grouping Uncertain", severity: "warning", hint: "An OCR-read SKU looked like a misread and was rejected — the item was kept as a shell." },
  REPOST_OLD_COPY: { label: "Duplicate on Nifty", severity: "warning", hint: "This item was posted to Nifty again — the previous listing stays up (at its old price) until you end/delete it on Nifty." },
  ETSY_NOT_LISTED: { label: "Vintage Not on Etsy", severity: "warning", hint: "This true-vintage item is live on Nifty but its Etsy slot is empty (Etsy was not connected when it was published). Use “List vintage on Etsy” on Past Uploads." },
  PRICE_STALE: { label: "Stale Price on Nifty", severity: "warning", hint: "The price was changed after upload — the listing on Nifty still shows the old price. Push the change from the Listings tab, or restore the price." },
  NO_SKU: { label: "Needs Review", severity: "warning" },
  QR_UNDECODABLE: { label: "Needs Review", severity: "warning" },
  UNCLEAR_GROUP: { label: "Needs Review", severity: "warning" },
  SIZE_MISSING: { label: "Needs Review", severity: "warning" },
  UNSUPPORTED_FORMAT: { label: "Needs Review", severity: "warning", hint: "A non-JPEG file was routed to needs-review." },

  // ---- Info: no action needed ----------------------------------------------
  SKU_SEQUENCE_INFO: { label: "Info", severity: "info", hint: "The batch's SKUs aren't one contiguous range — per-number gap warnings were suppressed." },
};

export function problemMeta(type: string): ProblemMeta {
  return META[type] ?? { label: "Needs Review", severity: "warning" };
}

export const RETIRED_PROBLEM_TYPES = ["RECONCILE_NEEDED","SOLD_STILL_LISTED","LISTING_EDIT_FAILED","MARKETPLACE_PUBLISH_FAILED","MARKETPLACE_LIST_FAILED","REPOST_OLD_COPY","ETSY_NOT_LISTED","PRICE_STALE"];
export const activeProblemsWhere = {resolved:false,type:{notIn:RETIRED_PROBLEM_TYPES}};
