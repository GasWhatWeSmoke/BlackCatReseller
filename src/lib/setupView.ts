import { setupProgress, blockingSteps, type SetupStep } from './setupSteps.ts';
import type { SetupRequest } from './setupState.ts';
export interface SetupView { steps: SetupStep[]; progress: { done: number; total: number; complete: boolean }; blocking: string[]; dismissed: boolean }
const stepIds = ['worker', 'folders', 'marketplace-accounts', 'second-monitor', 'ebay-policy', 'vision', 'first-batch', 'first-listing'];
export function setupView(input: unknown): SetupView {
  const data = input as SetupView;
  if (!data || !Array.isArray(data.steps) || data.steps.length !== stepIds.length || new Set(data.steps.map(step => step?.id)).size !== stepIds.length
    || data.steps.some(step => !step || !stepIds.includes(step.id) || typeof step.title !== 'string' || typeof step.detail !== 'string'
      || !['done', 'todo'].includes(step.state) || typeof step.blocking !== 'boolean' || (step.optional !== undefined && typeof step.optional !== 'boolean')
      || (step.manual !== undefined && typeof step.manual !== 'boolean') || (step.note !== undefined && typeof step.note !== 'string')
      || (step.href !== undefined && (typeof step.href !== 'string' || !step.href.startsWith('/') || step.href.startsWith('//'))) || (step.action !== undefined && typeof step.action !== 'string'))
    || typeof data.dismissed !== 'boolean' || !data.progress || !Array.isArray(data.blocking)) throw Error('Setup information could not be verified. Re-check to try again.');
  const progress = setupProgress(data.steps);
  if (progress.done !== data.progress.done || progress.total !== data.progress.total || progress.complete !== data.progress.complete
    || JSON.stringify(blockingSteps(data.steps).map(step => step.id)) !== JSON.stringify(data.blocking)) throw Error('Setup progress could not be verified. Re-check to try again.');
  return data;
}
export function setupReceipt(input: unknown, expected: SetupRequest) {
  const data = input as { ok: boolean; request: SetupRequest };
  if (!data || data.ok !== true || !data.request || typeof data.request !== 'object' || Array.isArray(data.request)
    || Object.keys(data.request).length !== ('dismissed' in expected ? 1 : 2) || ('dismissed' in expected
    ? !('dismissed' in data.request) || data.request.dismissed !== expected.dismissed
    : !('acknowledge' in data.request) || data.request.acknowledge !== expected.acknowledge || data.request.value !== expected.value)) throw Error('Your setup choice could not be confirmed. Re-check the saved state before trying again.');
  return data;
}
