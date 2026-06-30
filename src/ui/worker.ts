/// <reference lib="webworker" />
// Runs the engine off the main thread so large logs don't freeze the UI.
import { engine } from '../core/engine';
import type { MappingEntry, SanitizeOptions } from '../core/types';

type Req =
  | { id: number; kind: 'sanitize'; text: string; opts: SanitizeOptions }
  | { id: number; kind: 'desanitize'; text: string; mapping: MappingEntry[] };

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'sanitize') {
      self.postMessage({ id: msg.id, ok: true, res: engine.sanitize(msg.text, msg.opts) });
    } else {
      const segments = engine.desanitizeSegments(msg.text, msg.mapping);
      const out = segments.map((s) => s.text).join('');
      const gaps = engine.reverseGaps(msg.text, msg.mapping);
      self.postMessage({ id: msg.id, ok: true, res: { out, gaps, segments } });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err) });
  }
};
