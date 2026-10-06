export const DEFAULT_SALE_CHECK_MINUTES = 2;
export const MIN_SALE_CHECK_MINUTES = 2;
export const MAX_SALE_CHECK_MINUTES = 1440;
export const MAX_SALE_CHECKS_PER_DAY = 720;

export function validSaleChecksPerDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SALE_CHECKS_PER_DAY;
}

export function validSaleCheckMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= MIN_SALE_CHECK_MINUTES && value <= MAX_SALE_CHECK_MINUTES;
}

export function saleCheckMinutes(value: unknown, checksPerDay?: unknown): number {
  if (validSaleChecksPerDay(checksPerDay)) return 1440 / checksPerDay;
  return validSaleCheckMinutes(value) ? value : DEFAULT_SALE_CHECK_MINUTES;
}
