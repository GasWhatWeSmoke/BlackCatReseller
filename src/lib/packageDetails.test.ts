import test from 'node:test';
import assert from 'node:assert/strict';
import { describePackage, packageDetailLines } from './packageDetails.ts';

test('missing weights use labeled type estimates and unknown types keep the established fallback', () => {
  assert.deepEqual(describePackage({ itemType: 'T-shirt', weightOz: null }), {
    weightOz: 6, weightBasis: 'type_estimate', dimensions: { length: 9, width: 6, height: 1 },
  });
  const unknown = describePackage({ itemType: null });
  assert.equal(unknown.weightOz, 12); assert.deepEqual(unknown.dimensions, { length: 13, width: 10, height: 1 });
  assert.match(packageDetailLines(unknown)[0], /^Estimated weight: 12 oz/);
  assert.match(packageDetailLines(unknown)[1], /^Estimated dimensions:/);
});

test('a saved value is preserved without claiming it was measured or silently replacing invalid values', () => {
  const input = { itemType: 'Jacket', weightOz: 18 };
  const details = describePackage(input); assert.equal(details.weightOz, 18); assert.equal(details.weightBasis, 'saved_unverified');
  assert.deepEqual(input, { itemType: 'Jacket', weightOz: 18 });
  assert.match(packageDetailLines(details)[0], /may be estimated; measurement not recorded/);
  for (const weight of [0, -1, NaN, Infinity]) {
    const invalid = describePackage({ ...input, weightOz: weight });
    assert.equal(invalid.weightOz, weight); assert.match(packageDetailLines(invalid)[0], /^Invalid saved weight/);
  }
  assert.match(packageDetailLines(undefined)[0], /unavailable/);
  assert.match(packageDetailLines({ ...details, dimensions: { length: 0, width: 1, height: 1 } })[0], /unavailable/);
});

test('preview dimensions cannot mutate the shared type defaults used for later publications', () => {
  const preview = describePackage({ itemType: 'T-shirt' }); preview.dimensions.height = 100;
  assert.deepEqual(describePackage({ itemType: 'T-shirt' }).dimensions, { length: 9, width: 6, height: 1 });
});
