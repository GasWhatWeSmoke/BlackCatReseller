import type { PrismaClient } from '@prisma/client';
import { inventoryState } from './inventoryState.ts';
import { itemEditError, editedEvidence, expectedItemValuesError, conflictingItemFields, MONEY_FIELDS } from './itemEdits.ts';
import { bulkEditSelection, parseBulkEditChanges, type BulkEditSelection } from './bulkItemEdit.ts';
import { archiveCommand } from './bulkArchive.ts';
import { recordManualSale } from './manualSaleStore.ts';

type Store = Pick<PrismaClient, 'item' | 'marketplaceListing' | '$transaction'>;
function result<T extends object>(body: T, options: { status?: number } = {}) {
  return { body, status: options.status ?? 200 };
}

const EDITABLE = [
  "size", "itemType", "category", "color", "pattern", "brand", "notes", "publicNotes",
  "status", "platformSold", "whenMade",
  "department", "material", "style", "secondaryColor", "condition", "etsyEligible", "inseam",
  "trueVintage", "fit", "description", "customTitle",
  // buildTitle puts the model right after the brand, so it is one of the most
  // visible strings on a listing - it has to be correctable where it is seen.
  "model", "styleNumber",
  "tertiaryColor", "closure", "neckline", "lining", "graphics", "keyDetails", "aesthetic",
  "chestIn", "lengthIn", "sleeveIn", "shoulderIn", "waistIn", "hipIn", "riseIn",
] as const;

/** Apply an operator edit using the same transaction for every entry point. */
export async function applyItemChanges(db: Store, id: number, input: unknown) {
  const nid = id;
  let body = input as Record<string, unknown> | null;
  let bulk: BulkEditSelection | undefined;
  let archive: ReturnType<typeof archiveCommand> | undefined;
  if (!Number.isSafeInteger(nid) || nid <= 0) return result({ error: "bad id" }, { status: 400 });
  if (body && Object.hasOwn(body, 'manualSale')) {
    if (Object.keys(body).length !== 1) return result({ error: 'Confirm the sale separately from item edits.' }, { status: 422 });
    return recordManualSale(db, nid, body.manualSale);
  }
  if (body && Object.hasOwn(body, 'bulkArchive')) {
    try {
      archive = archiveCommand(body.bulkArchive);
      if (Object.keys(body).length !== 1 || archive.selection.id !== nid) throw Error('Archive only changes the confirmed item’s archive state.');
      body = { status: archive.action === 'archive' ? 'Archived' : 'Photographed' };
    } catch (error) { return result({ error: error instanceof Error ? error.message : 'Invalid archive action.' }, { status: 422 }); }
  }
  if (body && Object.hasOwn(body, 'bulkEdit')) {
    try {
      bulk = bulkEditSelection(body.bulkEdit);
      if (bulk.id !== nid) throw Error('The selected item does not match this edit.');
      const { bulkEdit: _selection, ...changes } = body;
      body = parseBulkEditChanges(changes);
    } catch (error) { return result({ error: error instanceof Error ? error.message : 'Invalid bulk edit.' }, { status: 422 }); }
  }
  const invalid = itemEditError(body);
  if (invalid && body?.shipped !== true) return result({ error: invalid }, { status: 422 });
  if (!body || typeof body !== "object" || Array.isArray(body)) return result({ error: "Expected item changes." }, { status: 400 });
  const expectedError = expectedItemValuesError(body.expectedValues, [...EDITABLE, ...MONEY_FIELDS, "weightOz", "aiFields", "flagged", "sku", "shippedAt", "createdAt", "updatedAt"]);
  if (expectedError) return result({ error: expectedError }, { status: 422 });
  const data: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in body) data[k] = body[k];
  // A cleared text input arrives as "" — store NULL for the fields whose emptiness
  // is MEANINGFUL downstream (the Ready gate and the size-less accessory export
  // check `?? / == null`, and "" silently defeated the auto-"One Size" path).
  for (const k of ["size", "itemType", "category", "color", "condition"]) {
    if (k in data && typeof data[k] === "string" && !(data[k] as string).trim()) data[k] = null;
  }
  if ("listedPrice" in body)
    data.listedPrice = body.listedPrice === null ? null : Number(body.listedPrice);
  if ("weightOz" in body)
    data.weightOz = body.weightOz === null || body.weightOz === "" ? null : Math.round(Number(body.weightOz));
  // Earnings money fields (§30). itemCost is the operator's cost basis. When the operator
  // enters fees/shipping by hand they become ACTUALS, so clear the "estimated" flag.
  const numOrNull = (v: unknown) => (v === null || v === "" ? null : Number(v));
  if ("itemCost" in body) data.itemCost = numOrNull(body.itemCost);
  if ("salePrice" in body) data.salePrice = numOrNull(body.salePrice);
  if ("marketplaceFees" in body) { data.marketplaceFees = numOrNull(body.marketplaceFees); data.feesEstimated = body.marketplaceFees === null || body.marketplaceFees === "" ? true : false; }
  if ("shippingCost" in body) { data.shippingCost = numOrNull(body.shippingCost); data.shippingEstimated = body.shippingCost === null || body.shippingCost === "" ? true : false; }
  if ("shippingCharged" in body) data.shippingCharged = numOrNull(body.shippingCharged);
  // aiFields is a JSON string of AI-filled, unconfirmed fields; allow clearing it
  // (reviewing an item confirms its values) or replacing it.
  if ("aiFields" in body)
    data.aiFields = body.aiFields === null ? null : JSON.stringify(body.aiFields);
  // Operator "come back to this" flag.
  if ("flagged" in body) data.flagged = !!body.flagged;
  // Fulfillment: mark a sold item's package shipped (true) or back to needs-shipping
  // (false). Timestamped server-side; operator-only, the sync never touches it.
  if ("shipped" in body) data.shippedAt = body.shipped ? new Date() : null;
  // SKU rename (batch recovery: renumber a FIX-xxxx shell to its real sticker number,
  // or fix a misread). Uniqueness is enforced by the DB; renaming clears the shell flag.
  if ("sku" in body) {
    const sku = String(body.sku ?? "").trim();
    if (!sku || sku.length > 32) {
      return result({ error: "SKU must be 1-32 characters." }, { status: 400 });
    }
    data.sku = sku;
    data.isShell = false;
  }
  try {
    let renamedFrom: string | null = null;
    let previousUpdatedAt: string | undefined;
    let priceWarning:string|null=null;
    if("listedPrice" in data) {
      const live=await db.marketplaceListing.findMany({where:{itemId:nid,status:"published"},select:{marketplace:true,price:true}});
      const different=live.filter(row=>row.price!=null && row.price!==data.listedPrice);
      if(different.length)priceWarning="Reviewed price saved locally. Existing marketplace listings keep their current prices; open their links to update them.";
    }
    const item = await db.$transaction(async tx => {
      const before = await tx.item.findUniqueOrThrow({ where: { id: nid } });
      if (archive) {
        const expected = archive.selection;
        if (before.createdAt.toISOString() !== expected.createdAt || before.sku !== expected.sku) throw new ItemEditConflict(['createdAt']);
        if (before.updatedAt.toISOString() !== expected.updatedAt || before.status !== expected.status) throw new ItemEditConflict(['updatedAt', 'status']);
        if (archive.action === 'restore' ? before.status !== 'Archived' : ['Archived', 'Removed'].includes(before.status))
          throw new InvalidItemEdit(archive.action === 'restore' ? 'Only archived items can be restored to Review.' : 'This item is already archived or removed.');
        data.updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1));
        if (archive.action === 'restore') data.readyFolderPath = null;
      }
      if (bulk) {
        if (before.createdAt.toISOString() !== bulk.createdAt || before.sku !== bulk.sku) throw new ItemEditConflict(['createdAt']);
        if (before.updatedAt.toISOString() !== bulk.updatedAt) throw new ItemEditConflict(['updatedAt']);
        if (!['Photographed', 'Needs Info', 'Ready', 'Ready for Nifty'].includes(before.status) || before.salePrice !== null ||
          before.niftyStatus !== 'Not Uploaded') throw new InvalidItemEdit('Bulk edits only apply to unpublished items awaiting review or approval.');
        const listing = await tx.marketplaceListing.findFirst({ where: { itemId: nid, status: { notIn: ['ended', 'not_published'] } }, select: { id: true } });
        if (listing) throw new InvalidItemEdit('Resolve this item’s live or uncertain marketplace listing before bulk editing.');
        const job = await tx.publishJob.findFirst({ where: { itemId: nid, status: { in: ['queued', 'retrying', 'publishing'] } }, select: { id: true } });
        if (job) throw new InvalidItemEdit('Cancel this item’s pending publishing work before bulk editing.');
        data.status = 'Photographed';
        data.readyFolderPath = null;
        data.updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1));
      }
      const conflicts = conflictingItemFields(before as unknown as Record<string, unknown>, body.expectedValues);
      if (conflicts.length) throw new ItemEditConflict(conflicts);
      const error = itemEditError(body, before.status);
      if (error) throw new InvalidItemEdit(error);
      if ((['Archived', 'Removed'].includes(String(data.status)) && data.status !== before.status) || archive?.action === 'restore') {
        const operation = archive?.action === 'restore' ? 'restoring it to Review' : 'archiving or removing it';
        if (before.status === 'Sold' || before.salePrice !== null)
          throw new InvalidItemEdit('Keep sold items in Sales. Use Returns for a refunded item before changing its inventory state.');
        if (before.niftyStatus !== 'Not Uploaded')
          throw new InvalidItemEdit(`Resolve this item’s historical marketplace activity before ${operation}.`);
        const listing = await tx.marketplaceListing.findFirst({ where: { itemId: nid, status: { notIn: ['ended', 'not_published'] } }, select: { id: true } });
        if (listing) throw new InvalidItemEdit(`Resolve this item’s live or uncertain marketplace listings before ${operation}.`);
        const job = await tx.publishJob.findFirst({ where: { itemId: nid, status: { in: ['queued', 'retrying', 'publishing'] } }, select: { id: true } });
        if (job) throw new InvalidItemEdit(`Finish or cancel this item’s publishing work before ${operation}.`);
      }
      const evidenceJson = editedEvidence(before as unknown as Record<string, unknown>, data);
      const saved = await tx.item.updateMany({ where: { id: nid, updatedAt: before.updatedAt }, data: { ...data, ...(evidenceJson !== undefined ? { evidenceJson } : {}) } });
      if (saved.count !== 1) throw new ItemEditConflict([]);
      previousUpdatedAt = before.updatedAt.toISOString();
      if (data.sku && before.sku !== data.sku) renamedFrom = before.sku;
      return tx.item.findUniqueOrThrow({ where: { id: nid }, include: { marketplaceListings: true } });
    });
    if (renamedFrom !== null) console.log(`[items] SKU rename #${nid}: ${renamedFrom} -> ${item.sku}`);
    return result({ item:{...item,displayStatus:inventoryState(item)}, previousUpdatedAt, priceWarning });
  } catch (e: unknown) {
    if (e instanceof ItemEditConflict) return result({ error: e.message, code: "ITEM_EDIT_CONFLICT", conflicts: e.fields }, { status: 409 });
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2034")
      return result({ error: "This item changed while saving. Your changes were not saved; refresh its saved values before trying again.", code: "ITEM_EDIT_CONFLICT" }, { status: 409 });
    if (e instanceof InvalidItemEdit) return result({ error: e.message }, { status: 422 });
    // P2025 = record not found — match the GET/DELETE handlers' clean 404.
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2025") {
      return result({ error: "not found" }, { status: 404 });
    }
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
      return result({ error: "That SKU is already in use by another item." }, { status: 409 });
    }
    return result(
      { error: e instanceof Error ? e.message : "update failed" },
      { status: 500 },
    );
  }
}

class InvalidItemEdit extends Error {}
class ItemEditConflict extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(fields.includes('createdAt')
      ? 'The original inventory item could not be confirmed. Your changes were not saved. Reload the item before saving.'
      : `This item changed since it was loaded${fields.length ? ` (${fields.join(", ")})` : ""}. Your changes were not saved. Compare the latest saved values before trying again.`);
    this.fields = fields;
  }
}
