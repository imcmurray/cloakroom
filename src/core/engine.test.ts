import { describe, it, expect } from 'vitest';
import { engine } from './engine';
import { encryptBridge, decryptBridge } from './crypto';

const SAMPLE = `
[2026-06-30 14:22:01] ERROR auth-service: login failed for ian.mcmurray@gmail.com
  from client 192.168.1.100 (also seen at 192.168.1.100 earlier)
  forwarded via gateway 10.20.30.40
  token=sk-live_AB12cd34EF56gh78IJ90kl12 aws=AKIAIOSFODNN7EXAMPLE
  user "Ian McMurray" employer "Moss Courthouse" ssn 521-22-1234 card 4111 1111 1111 1111
  trace 550e8400-e29b-41d4-a716-446655440000 at /home/ianm/secrets/key.pem
`;

describe('CloakroomEngine', () => {
  it('removes all sensitive originals from sanitized output', () => {
    const r = engine.sanitize(SAMPLE, {
      customTerms: [
        { value: 'Ian McMurray', type: 'PERSON' },
        { value: 'Moss Courthouse', type: 'ORG' },
      ],
    });
    for (const leak of [
      'ian.mcmurray@gmail.com',
      '192.168.1.100',
      '10.20.30.40',
      'sk-live_AB12cd34EF56gh78IJ90kl12',
      'AKIAIOSFODNN7EXAMPLE',
      'Ian McMurray',
      'Moss Courthouse',
      '521-22-1234',
      '4111 1111 1111 1111',
      '550e8400-e29b-41d4-a716-446655440000',
    ]) {
      expect(r.sanitized, `leaked: ${leak}`).not.toContain(leak);
    }
  });

  it('maps a repeated value to one consistent placeholder', () => {
    const r = engine.sanitize(SAMPLE);
    const ip = r.mapping.find((m) => m.original === '192.168.1.100');
    expect(ip?.count).toBe(2);
    const occurrences = r.sanitized.split(ip!.placeholder).length - 1;
    expect(occurrences).toBe(2);
  });

  it('round-trips: desanitize restores the original text exactly', () => {
    const r = engine.sanitize(SAMPLE, {
      customTerms: [
        { value: 'Ian McMurray', type: 'PERSON' },
        { value: 'Moss Courthouse', type: 'ORG' },
      ],
    });
    // Simulate an AI that echoes the sanitized text verbatim.
    const restored = engine.desanitize(r.sanitized, r.mapping);
    expect(restored).toBe(SAMPLE);
  });

  it('desanitizeSegments joins back to the same string and flags restored spans', () => {
    const r = engine.sanitize(SAMPLE, {
      customTerms: [{ value: 'Jane Doe', type: 'PERSON' }],
    });
    const segs = engine.desanitizeSegments(r.sanitized, r.mapping);
    // joining segments equals the plain desanitize output
    expect(segs.map((s) => s.text).join('')).toBe(engine.desanitize(r.sanitized, r.mapping));
    // every restored span's text is an original from the mapping
    const originals = new Set(r.mapping.map((m) => m.original));
    for (const s of segs.filter((x) => x.restored)) expect(originals.has(s.text)).toBe(true);
    // at least one restored span exists
    expect(segs.some((s) => s.restored)).toBe(true);
  });

  it('token mode produces opaque sentinels and still round-trips', () => {
    const r = engine.sanitize(SAMPLE, { mode: 'token' });
    expect(r.sanitized).toMatch(/«IPV4_\d+»/);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(SAMPLE);
  });

  it('detects and decoys federal case numbers and captions', () => {
    const src = 'matter "Smith v. Jones" case 2:23-cv-00456-DBB; bankruptcy In re Doe 23-12345';
    const r = engine.sanitize(src);
    expect(r.sanitized).not.toContain('2:23-cv-00456-DBB');
    expect(r.sanitized).not.toContain('Smith v. Jones');
    expect(r.mapping.some((m) => m.type === 'CASE_NUMBER')).toBe(true);
    expect(r.mapping.some((m) => m.type === 'CASE_NAME')).toBe(true);
    // case-number decoy keeps the cv/structure but changes the digits
    const cn = r.mapping.find((m) => m.type === 'CASE_NUMBER' && m.original === '2:23-cv-00456-DBB')!;
    expect(cn.placeholder).toMatch(/^\d:\d{2}-cv-\d{5}-[A-Z]{3}$/);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
  });

  it('decoys bare websites and phone numbers without touching email domains', () => {
    const src = 'call (801) 555-0142 or visit www.northwind-trading.com and ecf.utd.uscourts.gov; mail a@example-corp.com';
    const r = engine.sanitize(src);
    expect(r.sanitized).not.toContain('www.northwind-trading.com');
    expect(r.sanitized).not.toContain('ecf.utd.uscourts.gov');
    expect(r.mapping.some((m) => m.type === 'HOSTNAME')).toBe(true);
    expect(r.mapping.some((m) => m.type === 'PHONE')).toBe(true);
    // the email is handled as EMAIL (one mapping), not double-counted as a hostname
    expect(r.mapping.filter((m) => m.original === 'example-corp.com')).toHaveLength(0);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
  });

  it('does not mistake clock timestamps for IPv6, but still catches real IPv6', () => {
    const r = engine.sanitize('[2026-06-30 14:22:01] peer fe80::1ff:fe23:4567:890a connected');
    // the timestamp survives untouched
    expect(r.sanitized).toContain('14:22:01');
    expect(r.mapping.some((m) => m.original === '14:22:01')).toBe(false);
    // a genuine IPv6 address is detected and redacted IN FULL (no partial `fe80::` leak)
    expect(r.sanitized).not.toContain('fe80');
    const ip6 = r.mapping.find((m) => m.type === 'IPV6');
    expect(ip6?.original).toBe('fe80::1ff:fe23:4567:890a');
  });

  it('respects the whitelist', () => {
    const r = engine.sanitize('connect to 127.0.0.1 and 8.8.8.8', { whitelist: ['127.0.0.1'] });
    expect(r.sanitized).toContain('127.0.0.1');
    expect(r.sanitized).not.toContain('8.8.8.8');
  });

  it('generates Luhn-valid fake credit cards from the test BIN', () => {
    const r = engine.sanitize('card 4111 1111 1111 1111');
    const fake = r.mapping.find((m) => m.type === 'CREDIT_CARD')!.placeholder.replace(/\D/g, '');
    expect(fake[0]).toBe('4');
    // Luhn check
    let sum = 0, dbl = false;
    for (let i = fake.length - 1; i >= 0; i--) {
      let d = +fake[i];
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    expect(sum % 10).toBe(0);
  });

  it('encrypts and decrypts a bridge file with the right passphrase', async () => {
    const r = engine.sanitize(SAMPLE);
    const blob = await encryptBridge(r.mapping, 'correct horse battery staple');
    const back = await decryptBridge(blob, 'correct horse battery staple');
    expect(back.mapping).toEqual(r.mapping);
    await expect(decryptBridge(blob, 'wrong passphrase')).rejects.toThrow();
  });
});
