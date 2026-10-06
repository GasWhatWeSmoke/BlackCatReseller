import test from 'node:test';
import assert from 'node:assert/strict';
import { PRACTICE_ITEMS, newPracticeDrafts, updatePracticeDraft, practiceReviewError } from './practiceBatch.ts';

test('practice requires individual checks and catches three planted mistakes across ten items', () => {
  const drafts = newPracticeDrafts();
  assert.equal(PRACTICE_ITEMS.length, 10);
  assert.equal(new Set(PRACTICE_ITEMS.map(item => item.id)).size, 10);
  const errors: string[] = [];
  for (const item of PRACTICE_ITEMS) {
    assert.ok(practiceReviewError(item, drafts[item.id]));
    const checked = updatePracticeDraft(drafts[item.id], { photosChecked: true, labelChecked: true });
    if (practiceReviewError(item, checked)) errors.push(item.id);
    assert.equal(practiceReviewError(item, { ...checked, ...item.reference }), null);
  }
  assert.deepEqual(errors, ['PRACTICE-03', 'PRACTICE-07', 'PRACTICE-10']);
});

test('changing a reviewed practice item requires review again', () => {
  const item = PRACTICE_ITEMS[0];
  const reviewed = { ...newPracticeDrafts()[item.id], photosChecked: true, labelChecked: true, reviewed: true };
  assert.equal(updatePracticeDraft(reviewed, { color: 'Red' }).reviewed, false);
  assert.equal(updatePracticeDraft(reviewed, { photosChecked: false }).reviewed, false);
  assert.equal(reviewed.reviewed, true);
});

test('a fresh practice session cannot retain edits or change the reference data', () => {
  const first = newPracticeDrafts();
  first[PRACTICE_ITEMS[0].id].price = '999';
  first[PRACTICE_ITEMS[0].id].reviewed = true;
  const second = newPracticeDrafts();
  assert.equal(second[PRACTICE_ITEMS[0].id].price, '18');
  assert.equal(second[PRACTICE_ITEMS[0].id].reviewed, false);
  assert.equal(PRACTICE_ITEMS[0].reference.price, '18');
});

test('blank, nonnumeric and nonfinite practice prices never pass review', () => {
  const item = PRACTICE_ITEMS[0];
  for (const price of ['', ' ', 'NaN', 'Infinity', '-18', '0']) {
    assert.ok(practiceReviewError(item, { ...newPracticeDrafts()[item.id], photosChecked: true, labelChecked: true, price }));
  }
});
