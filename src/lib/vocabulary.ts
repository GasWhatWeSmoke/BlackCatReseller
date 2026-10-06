export type Vocabulary = Record<string, string[]>;
export interface VocabularyEntry { type: string; value: string }
export function vocabularyValues(vocab: Vocabulary | undefined, type: string): string[] {
  return vocab && Object.hasOwn(vocab, type) ? vocab[type] : [];
}
export function vocabularyEntry(input: unknown): VocabularyEntry {
  const entry = input as VocabularyEntry;
  if (!entry || typeof entry.type !== 'string' || typeof entry.value !== 'string' || !entry.type.trim() || !entry.value.trim()
    || entry.type.length > 64 || entry.value.length > 512 || /\0/.test(entry.type + entry.value)) throw Error('Choose a valid suggestion field and value.');
  return { type: entry.type.trim(), value: entry.value.trim() };
}
export function vocabularyView(input: unknown): { vocab: Vocabulary } {
  const data = input as { vocab: Vocabulary };
  if (!data || !data.vocab || typeof data.vocab !== 'object' || Array.isArray(data.vocab)
    || Object.values(data.vocab).some(values => !Array.isArray(values) || values.some(value => typeof value !== 'string'))) throw Error('Dropdown suggestions could not be verified. You can keep typing your own values.');
  return { vocab: Object.fromEntries(Object.entries(data.vocab).map(([type, values]) => [type, [...new Set(values)]])) };
}
export function learnedVocabulary(input: unknown, expected: VocabularyEntry): VocabularyEntry {
  const result = input as { ok: boolean; row: VocabularyEntry & { id: number } };
  if (!result || result.ok !== true || !result.row || !Number.isSafeInteger(result.row.id) || result.row.id < 1
    || result.row.type !== expected.type || result.row.value !== expected.value) throw Error('The suggestion update could not be confirmed.');
  return expected;
}
