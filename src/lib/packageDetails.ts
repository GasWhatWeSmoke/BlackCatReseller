import { estimateDims, estimateWeightOz } from './listing.ts';

export interface PackageDetails {
  weightOz: number;
  weightBasis: 'type_estimate' | 'saved_unverified';
  dimensions: { length: number; width: number; height: number };
}

/** Saved weights have no measurement provenance. Never infer it from a value or an AI flag. */
export function describePackage(item: { itemType?: string | null; weightOz?: number | null }): PackageDetails {
  return { weightOz: item.weightOz ?? estimateWeightOz(item.itemType ?? null),
    weightBasis: item.weightOz == null ? 'type_estimate' : 'saved_unverified',
    dimensions: { ...estimateDims(item.itemType ?? null) } };
}

export function packageDetailLines(value: PackageDetails | undefined): string[] {
  if (!value || !['type_estimate', 'saved_unverified'].includes(value.weightBasis) ||
    !value.dimensions || ![value.dimensions.length, value.dimensions.width, value.dimensions.height].every(number => Number.isFinite(number) && number > 0))
    return ['Package details unavailable. Refresh the queue or review this item.'];
  const weight = Number.isFinite(value.weightOz) && value.weightOz > 0
    ? value.weightBasis === 'type_estimate' ? `Estimated weight: ${value.weightOz} oz (item type).`
      : `Weight: ${value.weightOz} oz (may be estimated; measurement not recorded).`
    : 'Invalid saved weight. Enter a positive package weight or clear it to use the item-type estimate.';
  const { length, width, height } = value.dimensions;
  return [weight, `Estimated dimensions: ${length} × ${width} × ${height} in (item type).`];
}
