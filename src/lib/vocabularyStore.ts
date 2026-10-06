import type { PrismaClient } from '@prisma/client';
import { vocabularyEntry, type Vocabulary } from './vocabulary.ts';

export async function readVocabulary(db: Pick<PrismaClient, 'vocabulary'>) {
  const rows = await db.vocabulary.findMany({ orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }], select: { type: true, value: true } });
  const vocab: Vocabulary = Object.create(null);
  for (const row of rows) (vocab[row.type] ??= []).push(row.value);
  return { vocab };
}
export async function saveVocabularyEntry(db: Pick<PrismaClient, '$transaction'>, input: unknown) {
  const entry = vocabularyEntry(input);
  const row = await db.$transaction(async tx => {
    const existing = await tx.vocabulary.findUnique({ where: { type_value: entry } });
    if (existing) return existing;
    const last = await tx.vocabulary.aggregate({ where: { type: entry.type }, _max: { sortOrder: true } });
    return tx.vocabulary.upsert({ where: { type_value: entry }, update: {}, create: { ...entry, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  });
  return { ok: true as const, row };
}
