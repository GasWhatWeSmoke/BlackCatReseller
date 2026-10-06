import fs from "node:fs";
import path from "node:path";
import { normalizeSaleObservation, SALES_MARKETPLACES, type SaleObservation, type SalesMarketplace, validReceiptId } from "./salesProtocol.ts";

export interface SalesCheckpoint {
  version: 1;
  receipts: { marketplace: SalesMarketplace; receiptId: string; observations: SaleObservation[]; checkedAt?: string }[];
}
const checkpointPath = (root: string) => path.join(root, "direct-sales-checkpoint.json");

export function validateSalesCheckpoint(value: unknown): SalesCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sales checkpoint.");
  const raw = value as SalesCheckpoint;
  if (raw.version !== 1 || !Array.isArray(raw.receipts) || raw.receipts.length > 10000) throw new Error("Invalid sales checkpoint.");
  const seen = new Set<string>();
  const receipts = raw.receipts.map((receipt) => {
    if (!receipt || !SALES_MARKETPLACES.includes(receipt.marketplace) || !validReceiptId(receipt.marketplace, receipt.receiptId) ||
        !Array.isArray(receipt.observations) || receipt.observations.length < 1 || receipt.observations.length > 100) throw new Error("Invalid checkpoint receipt.");
    const key = `${receipt.marketplace}:${receipt.receiptId}`;
    if (seen.has(key)) throw new Error("Duplicate checkpoint receipt.");
    seen.add(key);
    const observations = receipt.observations.map((row) => {
      const observation = normalizeSaleObservation(receipt.marketplace, row);
      if (!observation || observation.receiptId !== receipt.receiptId || observation.classification !== "confirmed_sale") throw new Error("Checkpoint contains an unconfirmed sale.");
      return observation;
    });
    if (receipt.checkedAt !== undefined && (typeof receipt.checkedAt !== "string" || !Number.isFinite(Date.parse(receipt.checkedAt)))) throw new Error("Invalid receipt check time.");
    return { marketplace: receipt.marketplace, receiptId: receipt.receiptId, observations, ...(receipt.checkedAt ? { checkedAt: receipt.checkedAt } : {}) };
  });
  return { version: 1, receipts };
}

/** Explicit maintenance can revisit a bounded daily rotation for refunds.
 * Routine new-sale discovery does not request these historical reads. */
export function receiptsToRecheck(receipts: SalesCheckpoint["receipts"], now = Date.now()) {
  return receipts.filter(receipt => !receipt.checkedAt || now - Date.parse(receipt.checkedAt) >= 24 * 60 * 60_000)
    .sort((a,b) => Date.parse(a.checkedAt ?? "1970-01-01") - Date.parse(b.checkedAt ?? "1970-01-01"))
    .slice(0, 10).map(receipt => receipt.receiptId);
}

export function loadSalesCheckpoint(root: string): SalesCheckpoint {
  const file = checkpointPath(root);
  try {
    if (fs.statSync(file).size > 16_000_000) throw new Error("Sales checkpoint exceeds its size limit.");
    return validateSalesCheckpoint(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, receipts: [] };
    throw new Error(`Sales checkpoint needs review: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Database transitions complete before this rename. A crash before the save
 * causes receipt replay, which recordConfirmedSale handles idempotently. */
export function saveSalesCheckpoint(root: string, checkpoint: SalesCheckpoint): void {
  const contents = JSON.stringify(validateSalesCheckpoint(checkpoint));
  if (Buffer.byteLength(contents) > 16_000_000) throw new Error("Sales checkpoint exceeds its size limit.");
  fs.mkdirSync(root, { recursive: true });
  const file = checkpointPath(root), temporary = file + ".tmp";
  fs.writeFileSync(temporary, contents, "utf8");
  fs.renameSync(temporary, file);
}
