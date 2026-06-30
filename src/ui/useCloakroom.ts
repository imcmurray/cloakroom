import { useEffect, useRef, useCallback } from 'react';
import type { MappingEntry, RestoreSegment, SanitizeOptions, SanitizeResult } from '../core/types';

// Promise wrapper around the Web Worker. Each request gets an id; the worker
// echoes it back so we can resolve the right promise.
export function useCloakroom() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (v: unknown) => void>());
  const seq = useRef(0);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; res?: unknown; error?: string }>) => {
      const resolve = pending.current.get(e.data.id);
      if (!resolve) return;
      pending.current.delete(e.data.id);
      if (e.data.ok) resolve(e.data.res);
      else throw new Error(e.data.error);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const call = useCallback(<T,>(payload: object): Promise<T> => {
    const id = ++seq.current;
    return new Promise<T>((resolve) => {
      pending.current.set(id, resolve as (v: unknown) => void);
      workerRef.current!.postMessage({ id, ...payload });
    });
  }, []);

  const sanitize = useCallback(
    (text: string, opts: SanitizeOptions) => call<SanitizeResult>({ kind: 'sanitize', text, opts }),
    [call],
  );
  const desanitize = useCallback(
    (text: string, mapping: MappingEntry[]) =>
      call<{ out: string; gaps: MappingEntry[]; segments: RestoreSegment[] }>({
        kind: 'desanitize',
        text,
        mapping,
      }),
    [call],
  );

  return { sanitize, desanitize };
}
