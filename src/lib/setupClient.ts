import { setupView, setupReceipt } from './setupView.ts';
import type { SetupRequest } from './setupState.ts';
export async function readSetupView(signal: AbortSignal) {
  const response = await fetch('/api/setup', { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error(data?.error || 'Setup information is temporarily unavailable. Re-check to try again.');
  return setupView(data);
}
export async function saveSetupChoice(request: SetupRequest) {
  const response = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error(data?.error || 'Your setup choice could not be confirmed. Re-check before trying again.');
  return setupReceipt(data, request);
}
