"use client";
import { useCallback, useRef, useState } from 'react';
import { validRemovalReview, type RemovalReview } from '@/lib/publish/removalRecovery';
import { usePolledRead } from './usePolledRead';

interface ListingView {
  itemId: number;
  busy: boolean;
  listings: (Omit<RemovalReview, 'externalListingId' | 'externalUrl'> & {
    externalListingId: string | null; externalUrl: string | null;
  })[];
}

export function MarketplaceLinks({ itemId, disabled, onChanged }: {
  itemId: number; disabled: boolean; onChanged: () => Promise<unknown>;
}) {
  const read = useCallback(async (signal: AbortSignal): Promise<ListingView> => {
    const response = await fetch(`/api/items/${itemId}/listings`, { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result?.itemId !== itemId || typeof result.busy !== 'boolean' || !Array.isArray(result.listings)
      || result.listings.some((row: ListingView['listings'][number]) => !row || row.itemId !== itemId
        || !Number.isSafeInteger(row.id) || typeof row.marketplace !== 'string' || typeof row.status !== 'string'))
      throw new Error('Marketplace links could not be loaded.');
    return result;
  }, [itemId]);
  const view = usePolledRead(read, 15_000);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const savingRef = useRef(false);

  async function confirmRemoval(row: RemovalReview) {
    if (savingRef.current || disabled || !view.isFresh() || view.data?.busy || !validRemovalReview(row)) return;
    if (!confirm(`Confirm you already removed this exact listing on ${row.marketplace}. This records your confirmation; it does not delete a live marketplace listing.\n\nSKU ${row.sku}\n${row.externalUrl}`)) return;
    savingRef.current = true; setSaving(true); setMessage(''); view.invalidate();
    try {
      const response = await fetch('/api/publish/removals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm_manual_removal', confirmed: true, listing: row }) });
      const result = await response.json();
      if (!response.ok || result?.ok !== true || result.listingId !== row.id || result.status !== 'ended'
        || result.action !== 'confirm_manual_removal')
        throw new Error(result?.error || 'Removal confirmation could not be verified. Refresh before another action.');
      setMessage('Removal recorded. The item is held out of automatic posting. You can delete it once all marketplace links are resolved.');
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Removal confirmation could not be verified. Refresh before another action.');
    } finally {
      await view.load(); savingRef.current = false; setSaving(false);
    }
  }

  return <details className="card" style={{ padding: 14, marginBottom: 14 }} id="marketplace-links">
    <summary>Marketplace links</summary>
    <p>Already deleted a listing directly on its marketplace? Record that removal here before deleting the inventory item.</p>
    {(view.error || message) && <p role="status">{view.error || message}</p>}
    {view.data?.busy && <p>Finish or cancel this item&apos;s pending publishing work before recording removal.</p>}
    {view.data?.listings.map(row => <div key={row.id} style={{ marginBottom: 10, overflowWrap: 'anywhere' }}>
      <strong>{row.marketplace}</strong> · {row.status}
      {row.externalUrl && <div>{row.externalUrl}</div>}
      {validRemovalReview(row) && <button className="btn" data-diagnostic-action="listing_removed"
        disabled={disabled || saving || !view.fresh || view.data?.busy} onClick={() => void confirmRemoval(row)}>I removed this listing</button>}
    </div>)}
    {view.data?.listings.length === 0 && <p>No direct marketplace links recorded. Legacy Nifty listings must be resolved in Nifty.</p>}
    <button className="btn" disabled={saving} onClick={() => void view.load()}>Refresh marketplace links</button>
  </details>;
}
