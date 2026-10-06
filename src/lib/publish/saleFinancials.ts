/** Optional receipt actuals. Invalid money never prevents stock protection. */
export interface SaleFinancials {
  currency: "USD";
  salePriceCents: number;
  shippingChargedCents?: number;
  soldAt?: string;
}

export function normalizeSaleFinancials(value: unknown): SaleFinancials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;
  if (raw.currency !== "USD" || !cents(raw.salePriceCents)) return undefined;
  if (raw.shippingChargedCents !== undefined && !cents(raw.shippingChargedCents)) return undefined;
  if (raw.soldAt !== undefined && (typeof raw.soldAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(raw.soldAt) ||
      !Number.isFinite(Date.parse(raw.soldAt)) || new Date(raw.soldAt).toISOString() !== raw.soldAt)) return undefined;
  return { currency: "USD", salePriceCents: raw.salePriceCents,
    ...(raw.shippingChargedCents !== undefined ? { shippingChargedCents: raw.shippingChargedCents as number } : {}),
    ...(raw.soldAt !== undefined ? { soldAt: raw.soldAt as string } : {}) };
}
