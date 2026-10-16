import type { Prisma } from "@prisma/client";
import type { InventorySort } from "./inventoryQuery.ts";

// SQLite expressions are needed here: a CAST alone would turn malformed or
// missing SKUs into zero. No SKU values are rewritten and no schema is changed.
const validSku = "(length(CAST(i.\"sku\" AS BLOB)) = 9 AND i.\"sku\" GLOB 'BC-[0-9][0-9][0-9][0-9][0-9][0-9]')";
const skuNumber = `CASE WHEN ${validSku} THEN CAST(substr(i."sku", 4) AS INTEGER) END`;
const skuOrder = (direction: "ASC" | "DESC") => `CASE WHEN ${validSku} THEN 0 ELSE 1 END ASC, ${skuNumber} ${direction}, i."id" ASC`;
const displayState = `CASE
  WHEN i."status" IN ('Sold', 'Archived', 'Problem', 'Removed') THEN i."status"
  WHEN EXISTS (SELECT 1 FROM "MarketplaceListing" s WHERE s."itemId" = i."id" AND s."status" = 'published') THEN 'Listed'
  WHEN i."status" IN ('Ready', 'Ready for Nifty') THEN 'Ready'
  WHEN i."status" = 'Uploaded to Nifty' THEN 'Previously listed'
  WHEN i."status" IN ('Photographed', 'Needs Info') THEN 'Needs review'
  ELSE i."status" END`;

export function inventoryOrderBy(sort: InventorySort): string {
  // Only fixed, reviewed SQL fragments can become the ORDER BY clause.
  switch (sort) {
    case "sku-asc": return skuOrder("ASC");
    case "sku-desc": return skuOrder("DESC");
    case "newest": return 'i."createdAt" DESC, i."id" ASC';
    case "oldest": return 'i."createdAt" ASC, i."id" ASC';
    case "brand": return `i."brand" COLLATE NOCASE ASC, ${skuOrder("ASC")}`;
    case "status": return `${displayState} COLLATE NOCASE ASC, ${skuOrder("ASC")}`;
    default: throw new Error("Choose a supported inventory sort.");
  }
}

const itemFields = new Set(["id", "sku", "brand", "itemType", "category", "size", "color", "pattern", "model", "styleNumber",
  "customTitle", "finalTitle", "niftyTitle", "flagged", "batchId", "listedPrice", "salePrice", "platformSold", "createdAt", "dateSold", "dateListed", "status"]);
const listingFields = new Set(["status", "marketplace", "title", "publishedAt"]);

/** Compile the deliberately small filter subset emitted by inventoryWhere.
 * Keeps count, page, and neighbors on one filter definition. Values are always
 * bound parameters, fields are allowlisted, and new unsupported filters fail
 * closed rather than silently widening a result set. */
export function inventorySqlFilter(where: Prisma.ItemWhereInput): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    if (value instanceof Date) value = value.getTime();
    if (typeof value === "boolean") value = Number(value);
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Unsupported inventory filter value.");
    values.push(value); return "?";
  };
  function object(input: unknown, alias: "i" | "m"): string {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Unsupported inventory filter.");
    const parts: string[] = [];
    for (const [field, value] of Object.entries(input)) {
      if (field === "AND" || field === "OR") {
        const children = Array.isArray(value) ? value : [value];
        parts.push(children.length ? `(${children.map(child => object(child, alias)).join(` ${field} `)})` : field === "AND" ? "1" : "0");
      } else if (field === "marketplaceListings" && alias === "i") {
        if (!value || typeof value !== "object") throw new Error("Unsupported inventory relation filter.");
        for (const [mode, condition] of Object.entries(value)) {
          if (mode !== "some" && mode !== "none") throw new Error("Unsupported inventory relation filter.");
          parts.push(`${mode === "none" ? "NOT " : ""}EXISTS (SELECT 1 FROM "MarketplaceListing" m WHERE m."itemId" = i."id" AND ${object(condition, "m")})`);
        }
      } else {
        if (!(alias === "i" ? itemFields : listingFields).has(field)) throw new Error("Unsupported inventory filter column.");
        const column = `${alias}."${field}"`;
        if (value === null) parts.push(`${column} IS NULL`);
        else if (typeof value !== "object" || value instanceof Date) parts.push(`${column} = ${bind(value)}`);
        else {
          for (const [operator, operand] of Object.entries(value)) {
            if (operator === "in" || operator === "notIn") {
              if (!Array.isArray(operand)) throw new Error("Unsupported inventory filter list.");
              parts.push(operand.length ? `${column} ${operator === "notIn" ? "NOT " : ""}IN (${operand.map(bind).join(", ")})` : operator === "in" ? "0" : "1");
            } else if (operator === "contains") {
              if (typeof operand !== "string") throw new Error("Unsupported inventory text filter.");
              parts.push(`${column} LIKE ${bind(`%${operand}%`)}`);
            } else {
              const comparison = { equals: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[operator];
              if (!comparison) throw new Error("Unsupported inventory comparison.");
              parts.push(`${column} ${comparison} ${bind(operand)}`);
            }
          }
        }
      }
    }
    return parts.length ? `(${parts.join(" AND ")})` : "1";
  }
  return { sql: object(where, "i"), values };
}
