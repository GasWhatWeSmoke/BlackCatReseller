export interface ManifestPhoto {
  id: string; sequenceIndex: number; originalFilename: string; storedPath: string;
  sha256?: string; originalPath?: string;
}
export interface IntakeManifest {
  version: number; revision?: number; photos: ManifestPhoto[]; orderSource?: string; orderReviewRequired?: boolean;
}
export interface IntakeCorrections {
  revision: number; order?: string[]; markers: Record<string, string | null>;
  orderVerified?: boolean; correctedAt?: string; source?: string;
}
export interface VerificationGroup {
  sku: string; photoIds: string[]; markerPhotoId?: string | null; status?: string; reasons?: string[];
}
export interface IntakeVerification {
  version: number; revision: number; photos: ManifestPhoto[]; groups: VerificationGroup[];
  unresolved: { photoIds: string[]; reason: string }[]; orderSource?: string; orderReviewRequired?: boolean;
}

/** All corrections are explicit, optimistic revisions. Existing committed photos
 * are immutable here; inventory's separate editor owns subsequent item edits. */
export function validateIntakeCorrections(
  input: unknown, manifest: IntakeManifest, previous: IntakeCorrections | null,
  committedIds: ReadonlySet<string> = new Set(),
): IntakeCorrections {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid correction request.");
  const value = input as Record<string, unknown>;
  const revision = previous?.revision ?? 0;
  if (value.expectedRevision !== revision) throw Error("This batch changed. Reload before saving corrections.");
  const ids = manifest.photos.map(photo => photo.id), allowed = new Set(ids);
  if (allowed.size !== ids.length || !ids.length) throw Error("The source manifest is incomplete.");
  const beforeOrder = previous?.order ?? ids;
  const order = value.order ?? beforeOrder;
  if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some(id => typeof id !== "string" || !allowed.has(id)))
    throw Error("The corrected order must contain every original photo exactly once.");
  if (!value.markers || typeof value.markers !== "object" || Array.isArray(value.markers)) throw Error("Marker corrections must be a photo-to-SKU map.");
  const markers = { ...previous?.markers } as Record<string, string | null>;
  for (const [id, sku] of Object.entries(value.markers)) {
    if (!allowed.has(id)) throw Error("A correction references a photo outside this batch.");
    if (sku !== null && (typeof sku !== "string" || !/^BC-[0-9]{6}$/.test(sku))) throw Error("Use BC- followed by exactly six digits, or explicitly remove the marker.");
    if (committedIds.has(id) && sku !== markers[id]) throw Error("This photo is already saved to inventory. Edit that item in Inventory.");
    markers[id] = sku as string | null;
  }
  for (let index = 0; index < beforeOrder.length; index++) {
    if (committedIds.has(beforeOrder[index]) && order[index] !== beforeOrder[index]) throw Error("Already saved photo positions cannot change during batch recovery.");
  }
  // Moving unresolved photos across a committed range could attach them to an
  // already saved boundary. Keep each unresolved segment between saved photos.
  let segment = 0;
  const segments = new Map<string, number>();
  for (const id of beforeOrder) { if (committedIds.has(id)) segment++; else segments.set(id, segment); }
  segment = 0;
  for (const id of order as string[]) {
    if (committedIds.has(id)) segment++;
    else if (segments.get(id) !== segment) throw Error("Move photos only within the unresolved range; saved item boundaries are protected.");
  }
  if (value.orderVerified !== undefined && typeof value.orderVerified !== "boolean") throw Error("Invalid order confirmation.");
  const orderChanged = order.some((id, index) => id !== beforeOrder[index]);
  return { revision: revision + 1, order: order as string[], markers,
    orderVerified: value.orderVerified === true || (value.orderVerified === undefined && !orderChanged && previous?.orderVerified === true),
    correctedAt: new Date().toISOString(), source: "operator" };
}
