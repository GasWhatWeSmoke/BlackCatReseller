"use client";
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { usePolledRead } from './usePolledRead';
import { learnedVocabulary, vocabularyEntry, vocabularyView, vocabularyValues, type Vocabulary } from '@/lib/vocabulary';

async function read(signal: AbortSignal) {
  const response = await fetch('/api/vocab', { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error('Dropdown suggestions are unavailable. You can keep typing your own values.');
  return vocabularyView(data);
}
export function useVocabulary() {
  const view = usePolledRead(read, null);
  const [learned, setLearned] = useState<Vocabulary>({});
  const vocab = useMemo(() => Object.fromEntries([...new Set([...Object.keys(view.data?.vocab ?? {}), ...Object.keys(learned)])]
    .map(type => [type, [...new Set([...vocabularyValues(view.data?.vocab, type), ...vocabularyValues(learned, type)])]])), [view.data, learned]);
  const known = useRef(vocab); known.current = vocab;
  const confirmed = useRef(new Set<string>()), pending = useRef(new Map<string, Promise<void>>());
  const learn = useCallback(async (saved: Record<string, unknown>, types: readonly string[]) => {
    const outcomes = await Promise.all(types.map(async type => {
      const value = saved[type];
      if (typeof value !== 'string' || !value.trim()) return 0;
      try {
        const entry = vocabularyEntry({ type, value }), key = JSON.stringify(entry);
        if (confirmed.current.has(key) || vocabularyValues(known.current, type).includes(entry.value)) return 0;
        let task = pending.current.get(key);
        if (!task) {
          task = (async () => {
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
            try {
              const response = await fetch('/api/vocab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry), signal: controller.signal });
              const data = await response.json().catch(() => null);
              if (!response.ok) throw Error('Suggestion save failed.');
              learnedVocabulary(data, entry); confirmed.current.add(key);
              setLearned(previous => ({ ...previous, [type]: [...new Set([...vocabularyValues(previous, type), entry.value])] }));
            } finally { clearTimeout(timer); }
          })();
          pending.current.set(key, task);
        }
        try { await task; } finally { if (pending.current.get(key) === task) pending.current.delete(key); }
        return 0;
      } catch { return 1; }
    }));
    const failures = outcomes.reduce<number>((sum, count) => sum + count, 0);
    if (failures) toast.warning(`Item details were saved. ${failures} dropdown suggestion update(s) could not be confirmed.`, { duration: 8000 });
  }, []);
  return { vocab, learn, refresh: view.load, error: view.error, loading: view.refreshing, hasData: view.data !== null };
}
export function VocabularyNotice({ state }: { state: ReturnType<typeof useVocabulary> }) {
  if (!state.error && (state.hasData || !state.loading)) return null;
  return <div role={state.error ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, margin: '12px 0', fontSize: 13 }}>
    <span style={{ flex: 1, minWidth: 160 }}>{state.error || 'Loading dropdown suggestions. You can keep typing your own values.'}{state.error && state.hasData ? ' The last available suggestions are kept.' : ''}</span>
    <button className="btn" onClick={() => void state.refresh()}>{state.error ? 'Retry suggestions' : 'Reload suggestions'}</button>
  </div>;
}
