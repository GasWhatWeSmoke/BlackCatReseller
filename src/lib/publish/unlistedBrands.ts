/** Explicit operator approvals; omitting the field must preserve earlier choices. */
export function unlistedBrands(patch: Record<string, unknown>, current: string[] = []): string[] {
  if (!("unlistedBrands" in patch)) return current;
  const value = patch.unlistedBrands;
  if (!Array.isArray(value) || value.length > 100 || value.some(brand =>
    typeof brand !== "string" || !brand.trim() || brand.trim().length > 100)) {
    throw new Error("Approved unlisted brands must be a list of up to 100 nonempty brand names (100 characters each).");
  }
  return [...new Set(value.map(brand => brand.trim()))];
}
