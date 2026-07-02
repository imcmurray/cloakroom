import { describe, it, expect } from 'vitest';
import { engine } from '../core/engine';
import { segmentizeSanitized, decideSelectionAction } from './review';

const SRC = 'login for admin@corp.com from 10.1.2.3; note ProjectX unchanged';

describe('segmentizeSanitized', () => {
  it('splits sanitized text into decoy and untouched segments that rejoin exactly', () => {
    const r = engine.sanitize(SRC);
    const segs = segmentizeSanitized(r.sanitized, r.mapping);
    expect(segs.map((s) => s.text).join('')).toBe(r.sanitized);
    // both decoys present as entry-bearing segments
    const decoys = segs.filter((s) => s.entry).map((s) => s.entry!.type).sort();
    expect(decoys).toEqual(['EMAIL', 'IPV4']);
    // untouched text (the missed term) carries no entry — that's the review signal
    expect(segs.some((s) => !s.entry && s.text.includes('ProjectX'))).toBe(true);
  });

  it('handles empty mapping and empty text', () => {
    expect(segmentizeSanitized('abc', [])).toEqual([{ text: 'abc' }]);
    expect(segmentizeSanitized('', [])).toEqual([{ text: '' }]);
  });
});

describe('decideSelectionAction', () => {
  const r = engine.sanitize(SRC);
  const ipDecoy = r.mapping.find((m) => m.type === 'IPV4')!;

  it('plain leftover text → cloak', () => {
    expect(decideSelectionAction('  ProjectX ', r.mapping)).toEqual({ kind: 'cloak', value: 'ProjectX' });
  });

  it('an exact decoy → uncloak, and the exact original too', () => {
    expect(decideSelectionAction(ipDecoy.placeholder, r.mapping)).toEqual({ kind: 'uncloak', entry: ipDecoy });
    expect(decideSelectionAction('10.1.2.3', r.mapping)).toEqual({ kind: 'uncloak', entry: ipDecoy });
  });

  it('blocks multi-line, pipe, decoy-crossing, and empty selections with reasons', () => {
    expect(decideSelectionAction('a\nb', r.mapping).kind).toBe('blocked');
    expect(decideSelectionAction('a | b', r.mapping).kind).toBe('blocked');
    expect(decideSelectionAction(`from ${ipDecoy.placeholder};`, r.mapping).kind).toBe('blocked');
    expect(decideSelectionAction('   ', r.mapping).kind).toBe('blocked');
  });
});
