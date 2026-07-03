import { describe, it, expect } from 'vitest';
import { parseTermPack, serializeTermPack, mergePack } from './packs';

describe('term pack format (shared by CLI, hooks, and browser)', () => {
  it('parse → serialize → parse round-trips', () => {
    const src = serializeTermPack('moss', [
      { value: 'Judge Kwan', type: 'PERSON' },
      { value: 'UTB-CMS' },
    ], ['pacer.uscourts.gov']);
    const p = parseTermPack(src);
    expect(p.name).toBe('moss');
    expect(p.customTerms).toEqual([{ value: 'Judge Kwan', type: 'PERSON' }, { value: 'UTB-CMS' }]);
    expect(p.whitelist).toEqual(['pacer.uscourts.gov']);
    expect(parseTermPack(serializeTermPack('again', p.customTerms, p.whitelist))).toMatchObject({
      customTerms: p.customTerms, whitelist: p.whitelist,
    });
  });

  it('accepts bare-string terms and trims whitespace', () => {
    const p = parseTermPack('{"customTerms":["  Acme Corp  "],"whitelist":[" ok.example.gov "]}');
    expect(p.customTerms).toEqual([{ value: 'Acme Corp' }]);
    expect(p.whitelist).toEqual(['ok.example.gov']);
  });

  it('REJECTS malformed packs instead of silently skipping entries', () => {
    expect(() => parseTermPack('not json')).toThrow(/JSON/);
    expect(() => parseTermPack('[]')).toThrow(/object/);
    expect(() => parseTermPack('{"customTerms":"nope"}')).toThrow(/array/);
    expect(() => parseTermPack('{"customTerms":[42]}')).toThrow(/entry/);
    expect(() => parseTermPack('{"whitelist":[null]}')).toThrow(/whitelist/);
    expect(() => parseTermPack('{"customTerms":[{"type":"PERSON"}]}')).toThrow(/entry/);
  });

  it('mergePack dedupes by exact value and counts added/skipped', () => {
    const r = mergePack(
      [{ value: 'Judge Kwan', type: 'PERSON' }],
      ['127.0.0.1'],
      { customTerms: [{ value: 'Judge Kwan' }, { value: 'UTB-CMS' }], whitelist: ['127.0.0.1', 'pacer.uscourts.gov'] },
    );
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.terms.map((t) => t.value)).toEqual(['Judge Kwan', 'UTB-CMS']);
    expect(r.whitelist).toEqual(['127.0.0.1', 'pacer.uscourts.gov']);
    // existing entry keeps ITS type (the pack's duplicate doesn't overwrite)
    expect(r.terms[0].type).toBe('PERSON');
  });
});
