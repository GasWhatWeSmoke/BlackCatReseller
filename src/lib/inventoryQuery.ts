import type { Prisma, PrismaClient } from "@prisma/client";
import { inventoryState, inventoryStateFilter } from "./inventoryState.ts";

export const INVENTORY_STATES = ["", "Needs review", "Ready", "Listed", "Sold", "Problem", "Archived", "Removed", "Previously listed"];
export const INVENTORY_MARKETPLACES = ["", "ebay", "depop", "poshmark", "mercari", "etsy"];
export interface InventoryQuery {
  q: string; state: string; flagged: boolean; sku: string; brand: string; category: string; size: string; itemType: string;
  marketplace: string; priceField: "listed" | "sold"; priceMin: string; priceMax: string; batch: string;
  dateField: "added" | "listed" | "sold"; dateFrom: string; dateTo: string; page: number; pageSize: number;
}
export const DEFAULT_INVENTORY_QUERY: InventoryQuery = { q: "", state: "", flagged: false, sku: "", brand: "", category: "", size: "",
  itemType: "", marketplace: "", priceField: "listed", priceMin: "", priceMax: "", batch: "", dateField: "added", dateFrom: "", dateTo: "", page: 1, pageSize: 50 };

function text(params: URLSearchParams, key: string, max = 100): string {
  const value = (params.get(key) ?? "").trim();
  if (value.length > max) throw new Error(`${key}: use at most ${max} characters.`);
  return value;
}
function positive(value: string | null, fallback: number, maximum: number): number {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum)
    throw new Error("Choose a valid inventory page and page size.");
  return Number(value);
}
function money(value: string): number | undefined {
  if (!value) return undefined;
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER / 100)
    throw new Error("Price filters must be positive amounts or zero, with at most two decimal places.");
  return Number(value);
}
function localDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid calendar date.");
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 9999) throw new Error("Choose a date from 1900 through 9999.");
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error("Choose a valid calendar date.");
  return date;
}
export function inventoryDateRange(from: string, to: string): Prisma.DateTimeNullableFilter | undefined {
  if (!from && !to) return undefined;
  const start = from ? localDay(from) : undefined;
  const last = to ? localDay(to) : undefined;
  if (start && last && start > last) throw new Error("The start date must be on or before the end date.");
  const end = last ? new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) : undefined;
  return { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
}

export function parseInventoryQuery(params: URLSearchParams): InventoryQuery {
  const query: InventoryQuery = { ...DEFAULT_INVENTORY_QUERY, q: text(params, "q", 200), state: text(params, "state"),
    flagged: params.get("flagged") === "1", sku: text(params, "sku", 32), brand: text(params, "brand"), category: text(params, "category"),
    size: text(params, "size"), itemType: text(params, "itemType"), marketplace: text(params, "marketplace"), priceField: (params.get("priceField") || "listed") as InventoryQuery["priceField"], priceMin: text(params, "priceMin", 30),
    priceMax: text(params, "priceMax", 30), batch: text(params, "batch", 12), dateField: (params.get("dateField") || "added") as InventoryQuery["dateField"],
    dateFrom: text(params, "dateFrom", 10), dateTo: text(params, "dateTo", 10), page: positive(params.get("page"), 1, 1_000_000),
    pageSize: positive(params.get("pageSize"), 50, 100) };
  if (!INVENTORY_STATES.includes(query.state) || !INVENTORY_MARKETPLACES.includes(query.marketplace) || !["added", "listed", "sold"].includes(query.dateField) || !["listed", "sold"].includes(query.priceField))
    throw new Error("Choose supported inventory filters.");
  const min = money(query.priceMin), max = money(query.priceMax);
  if (min !== undefined && max !== undefined && min > max) throw new Error("Minimum price must not exceed maximum price.");
  if (query.batch && (!/^\d+$/.test(query.batch) || !Number.isSafeInteger(Number(query.batch)) || Number(query.batch) < 1)) throw new Error("Enter a valid batch number.");
  inventoryDateRange(query.dateFrom, query.dateTo);
  return query;
}

export function inventoryQueryString(query: InventoryQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "flagged") { if (value) params.set(key, "1"); }
    else if (value !== "" && value !== DEFAULT_INVENTORY_QUERY[key as keyof InventoryQuery]) params.set(key, String(value));
  }
  return params.toString();
}

export function inventoryItemHref(id: number, query: InventoryQuery): string {
  const context = inventoryQueryString(query);
  return `/inventory/${id}${context ? `?from=${encodeURIComponent(context)}` : ""}`;
}
export function inventoryBackHref(query: InventoryQuery): string {
  const context = inventoryQueryString(query);
  return `/inventory${context ? `?${context}` : ""}`;
}

export function inventoryWhere(query: InventoryQuery): Prisma.ItemWhereInput {
  const conditions: Prisma.ItemWhereInput[] = [inventoryStateFilter(query.state)];
  if (query.q) conditions.push({ OR: [...["sku", "brand", "itemType", "category", "size", "color", "pattern", "model", "styleNumber", "customTitle", "finalTitle", "niftyTitle"].map(field => ({ [field]: { contains: query.q } })),
    { marketplaceListings: { some: { title: { contains: query.q } } } }] });
  if (query.flagged) conditions.push({ flagged: true });
  if (query.sku) conditions.push({ sku: query.sku });
  if (query.brand) conditions.push({ brand: { contains: query.brand } });
  if (query.itemType) conditions.push({ itemType: { contains: query.itemType } });
  if (query.size) conditions.push({ size: query.size });
  if (query.category) conditions.push(query.category === "__unset__" ? { OR: [{ category: null }, { category: "" }] } : { category: query.category });
  if (query.batch) conditions.push({ batchId: Number(query.batch) });
  if (query.priceMin || query.priceMax) conditions.push({ [query.priceField === "sold" ? "salePrice" : "listedPrice"]: { ...(query.priceMin ? { gte: money(query.priceMin) } : {}), ...(query.priceMax ? { lte: money(query.priceMax) } : {}) } });
  if (query.marketplace) {
    const marketplace = query.marketplace;
    if (query.state === "Listed") conditions.push({ marketplaceListings: { some: { marketplace, status: "published" } } });
    else if (query.state === "Sold") conditions.push({ OR: [{ platformSold: { contains: marketplace } }, { marketplaceListings: { some: { marketplace, status: "sold" } } }] });
    else conditions.push({ OR: [{ marketplaceListings: { some: { marketplace } } }, { platformSold: { contains: marketplace } }] });
  }
  const date = inventoryDateRange(query.dateFrom, query.dateTo);
  if (date) {
    if (query.dateField === "added") conditions.push({ createdAt: date as Prisma.DateTimeFilter });
    else if (query.dateField === "sold") conditions.push({ dateSold: date });
    else conditions.push({ OR: [{ dateListed: date }, { marketplaceListings: { some: { publishedAt: date } } }] });
  }
  return { AND: conditions };
}

const SUMMARY_SELECT = {
  id: true, sku: true, status: true, brand: true, size: true, itemType: true, category: true, color: true, pattern: true,
  customTitle: true, finalTitle: true, niftyTitle: true, listedPrice: true, salePrice: true, platformSold: true, batchId: true,
  flagged: true, aiFields: true, groupingConfidence: true, isShell: true, createdAt: true, updatedAt: true,
  photos: { where: { isMarker: false }, orderBy: [{ includeInListing: "desc" }, { isCover: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    take: 1, select: { id: true, storedPath: true, thumbPath: true, rotation: true } },
  marketplaceListings: { orderBy: { marketplace: "asc" }, select: { marketplace: true, status: true, price: true, title: true, lastError: true } },
} satisfies Prisma.ItemSelect;

export async function inventoryPage(db: Pick<PrismaClient, "$transaction">, query: InventoryQuery) {
  return db.$transaction(async tx => {
    const where = inventoryWhere(query), total = await tx.item.count({ where });
    const pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
    const rows = await tx.item.findMany({ where, orderBy: { sku: "asc" }, skip: (page - 1) * query.pageSize, take: query.pageSize, select: SUMMARY_SELECT });
    // A nested relation count aggregates the whole Photo table in SQLite. Count
    // only this page's IDs, keeping exact totals without scanning old inventory.
    const counts = rows.length ? await tx.photo.groupBy({ by: ["itemId", "includeInListing"], where: { itemId: { in: rows.map(row => row.id) }, isMarker: false }, _count: { _all: true } }) : [];
    const selected = new Map<number | null, number>(), allPhotos = new Map<number | null, number>();
    for (const count of counts) {
      allPhotos.set(count.itemId, (allPhotos.get(count.itemId) ?? 0) + count._count._all);
      if (count.includeInListing) selected.set(count.itemId, count._count._all);
    }
    return { items: rows.map(row => ({ id: row.id, sku: row.sku, status: row.status, displayStatus: inventoryState(row),
      title: row.customTitle || row.finalTitle || row.niftyTitle || row.marketplaceListings.find(listing => ["published", "sold"].includes(listing.status) && listing.title)?.title || [row.brand, row.itemType, row.color, row.size].filter(Boolean).join(" "),
      brand: row.brand, size: row.size, itemType: row.itemType, category: row.category, color: row.color, pattern: row.pattern,
      listedPrice: row.listedPrice, salePrice: row.salePrice, platformSold: row.platformSold, batchId: row.batchId,
      flagged: row.flagged, needsAiReview: !!row.aiFields && row.aiFields !== "[]", groupingConfidence: row.groupingConfidence,
      isShell: row.isShell, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      cover: row.photos[0] ?? null, photoCount: allPhotos.get(row.id) ?? 0, selectedPhotoCount: selected.get(row.id) ?? 0,
      marketplaceListings: row.marketplaceListings })), page, pageSize: query.pageSize, pages, total };
  });
}
export type InventoryPage = Awaited<ReturnType<typeof inventoryPage>>;
export type InventorySummary = InventoryPage["items"][number];

export async function inventoryNeighbors(db: Pick<PrismaClient, "$transaction">, id: number, query: InventoryQuery) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid inventory item.");
  return db.$transaction(async tx => {
    const current = await tx.item.findUnique({ where: { id }, select: { id: true, sku: true } });
    if (!current) return null;
    const where = inventoryWhere(query);
    const total = await tx.item.count({ where });
    const matching = await tx.item.count({ where: { AND: [where, { id }] } });
    if (!matching) return { prev: null, next: null, index: -1, total, matches: false };
    const [prev, next, index] = await Promise.all([
      tx.item.findFirst({ where: { AND: [where, { sku: { lt: current.sku } }] }, orderBy: { sku: "desc" }, select: { id: true } }),
      tx.item.findFirst({ where: { AND: [where, { sku: { gt: current.sku } }] }, orderBy: { sku: "asc" }, select: { id: true } }),
      tx.item.count({ where: { AND: [where, { sku: { lt: current.sku } }] } }),
    ]);
    return { prev: prev?.id ?? null, next: next?.id ?? null, index, total, matches: true };
  });
}
