export type PracticeFields = { itemType: string; color: string; size: string; price: string };
export type PracticeItem = { id: string; reference: PracticeFields; photoCount: number; shape: 'top' | 'bottom' | 'dress'; swatch: string };
export type PracticeDraft = PracticeFields & { photosChecked: boolean; labelChecked: boolean; reviewed: boolean };

// Fictional training records stay entirely outside the inventory and publishing stores.
export const PRACTICE_ITEMS: readonly PracticeItem[] = [
  ['T-Shirt', 'Blue', 'M', '18', 'top', '#4c7bc0'],
  ['Jeans', 'Blue', '32', '28', 'bottom', '#365881'],
  ['Sweater', 'Green', 'L', '24', 'top', '#497c65'],
  ['Dress', 'Red', 'S', '32', 'dress', '#b75464'],
  ['Jacket', 'Gray', 'M', '40', 'top', '#717d88'],
  ['Shorts', 'Brown', '30', '20', 'bottom', '#967556'],
  ['Hoodie', 'Black', 'XL', '30', 'top', '#363e48'],
  ['Skirt', 'Purple', 'M', '22', 'dress', '#866aaf'],
  ['Shirt', 'White', 'L', '26', 'top', '#c7d0d9'],
  ['Pants', 'Green', '34', '25', 'bottom', '#607a65'],
].map(([itemType, color, size, price, shape, swatch], index) => ({
  id: `PRACTICE-${String(index + 1).padStart(2, '0')}`,
  reference: { itemType, color, size, price }, photoCount: 3,
  shape: shape as PracticeItem['shape'], swatch,
}));

export function newPracticeDrafts(): Record<string, PracticeDraft> {
  return Object.fromEntries(PRACTICE_ITEMS.map((item, index) => [item.id, {
    ...item.reference,
    ...(index === 2 ? { color: 'Blue' } : index === 6 ? { size: '' } : index === 9 ? { price: '' } : {}),
    photosChecked: false, labelChecked: false, reviewed: false,
  }]));
}

export function updatePracticeDraft(draft: PracticeDraft, change: Partial<Omit<PracticeDraft, 'reviewed'>>): PracticeDraft {
  return { ...draft, ...change, reviewed: false };
}

export function practiceReviewError(item: PracticeItem, draft: PracticeDraft): string | null {
  if (!draft.photosChecked || !draft.labelChecked) return 'Check the sample views and reference label before finishing this item.';
  if (draft.itemType.trim() !== item.reference.itemType || draft.color.trim() !== item.reference.color || draft.size.trim() !== item.reference.size)
    return 'Compare item type, color and size with the fictional reference. Correct any missing or different details.';
  if (draft.price.trim() === '' || !Number.isFinite(Number(draft.price)) || Number(draft.price) !== Number(item.reference.price))
    return 'Enter the practice price shown on the reference card. Real prices are your decision.';
  return null;
}
