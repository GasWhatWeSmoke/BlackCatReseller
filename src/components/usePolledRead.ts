"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Poll one view without overlapping reads or letting an older reply win.
 * Explicit refreshes and post-mutation reads replace any pending observation. */
export function usePolledRead<T>(read: (signal: AbortSignal) => Promise<T>, interval: number | null | ((data: T | null) => number)) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [fresh, setFresh] = useState(false);
  const freshRef = useRef(false);
  const version = useRef(0);
  const active = useRef<{ controller: AbortController; promise: Promise<boolean> } | null>(null);
  const invalidate = useCallback(() => {
    version.current++; active.current?.controller.abort(); active.current = null;
    freshRef.current = false; setFresh(false);
  }, []);
  const load = useCallback((replace = true): Promise<boolean> => {
    if (active.current && !replace) return active.current.promise;
    const current = ++version.current;
    active.current?.controller.abort();
    const controller = new AbortController();
    freshRef.current = false; setFresh(false); setRefreshing(true);
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await read(controller.signal);
        if (controller.signal.aborted || current !== version.current) return false;
        setData(result); setError(null); freshRef.current = true; setFresh(true);
        return true;
      } catch (failure) {
        if (!controller.signal.aborted && current === version.current)
          setError(failure instanceof Error ? failure.message : "This view could not be refreshed.");
        return false;
      } finally {
        if (current === version.current) { active.current = null; setRefreshing(false); }
      }
    });
    active.current = { controller, promise };
    return promise;
  }, [read]);
  useEffect(() => {
    void load(false);
    return () => { version.current++; active.current?.controller.abort(); active.current = null; freshRef.current = false; };
  }, [load]);
  const milliseconds = typeof interval === "function" ? interval(data) : interval;
  useEffect(() => { if(milliseconds===null)return; const timer = setInterval(() => void load(false), milliseconds); return () => clearInterval(timer); }, [load, milliseconds]);
  const isFresh = useCallback(() => freshRef.current, []);
  return { data, error, refreshing, fresh, isFresh, load, invalidate };
}
