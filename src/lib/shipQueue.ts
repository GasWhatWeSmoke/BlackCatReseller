// Shared fulfillment queue: sold items not yet shipped or handed over for pickup.
// Keep the existing event name for compatibility with both fulfillment views.
export const SHIP_QUEUE_CHANGED = "bca-ship-queue-changed";

export function shippingCount(value: unknown): { count: number } {
  const result = value as { count: number };
  if (!result || !Number.isSafeInteger(result.count) || result.count < 0) throw Error('The fulfillment count could not be verified.');
  return { count: result.count };
}

export function announceShipQueueChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SHIP_QUEUE_CHANGED));
}
