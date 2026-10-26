import { describe, it, expect } from 'vitest';
import { engine } from './engine';
import { isLikelyDecoy } from './generators';

// Test secrets are assembled from pieces so this file never contains a
// literal that GitHub push protection (or Cloakroom's own scan) would flag.
const ANTHROPIC = 'sk-ant-' + 'api03-' + 'A1b2'.repeat(10);
const OPENAI = 'sk-proj-' + 'Q9w8'.repeat(8);
const STRIPE = 'sk_' + 'live_' + 'Z7y6'.repeat(6);
const GITHUB_PAT = 'github_' + 'pat_' + '11ABCDEFG0_' + 'x'.repeat(40);
const GITLAB_PAT = 'glpat-' + 'k9'.repeat(10);
const NPM = 'npm_' + 'N4m5'.repeat(9);
const GOOGLE = 'AIza' + 'Sy' + 'G7'.repeat(16) + 'h';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY';
const PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
  'b3Bl'.repeat(16) +
  '\n' +
  'QUJD'.repeat(16) +
  '\n-----END OPENSSH PRIVATE KEY-----';

describe('secret detectors', () => {
  const cases: Array<[string, string, string]> = [
    ['Anthropic key', `ANTHROPIC_API_KEY ${ANTHROPIC}`, ANTHROPIC],
    ['OpenAI project key', `key ${OPENAI} end`, OPENAI],
    ['Stripe live key', `stripe ${STRIPE}`, STRIPE],
    ['GitHub fine-grained PAT', `gh ${GITHUB_PAT}`, GITHUB_PAT],
    ['GitLab PAT', `gl ${GITLAB_PAT}`, GITLAB_PAT],
    ['npm token', `//registry.npmjs.org/:_authToken ${NPM}`, NPM],
    ['Google API key', `maps ${GOOGLE}`, GOOGLE],
    ['AWS secret access key', `aws_secret_access_key = ${AWS_SECRET}`, AWS_SECRET],
    ['password= assignment', 'password=CorrectHorseBatteryStaple9', 'CorrectHorseBatteryStaple9'],
    ['env-style key', 'DB_PASSWORD: hunter2hunter2', 'hunter2hunter2'],
    ['JSON secret', '{"client_secret": "s3cr3t-v4lue-0042"}', 's3cr3t-v4lue-0042'],
    ['URI password', 'postgres://admin:Hunter2Secret@db.internal:5432/prod', 'Hunter2Secret'],
    ['PEM private key', `key:\n${PEM}\nend`, 'b3Bl'.repeat(16)],
  ];

  for (const [label, src, secret] of cases) {
    it(`detects and round-trips: ${label}`, () => {
      const r = engine.sanitize(src);
      expect(r.sanitized, `leaked: ${label}`).not.toContain(secret);
      expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
    });
  }

  it('replaces only the value of a key=value secret, keeping the key name', () => {
    const r = engine.sanitize('DB_PASSWORD=hunter2hunter2 next');
    expect(r.sanitized).toMatch(/^DB_PASSWORD=\S+ next$/);
    expect(r.mapping.find((m) => m.type === 'SECRET')?.original).toBe('hunter2hunter2');
  });

  it('keeps the PEM armor lines on the decoy', () => {
    const r = engine.sanitize(PEM);
    expect(r.sanitized.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(r.sanitized.endsWith('\n-----END OPENSSH PRIVATE KEY-----')).toBe(true);
  });

  it('keeps the scheme and user of a connection string', () => {
    const r = engine.sanitize('postgres://admin:Hunter2Secret@db.internal:5432/prod');
    expect(r.sanitized.startsWith('postgres://admin:')).toBe(true);
  });
});

describe('decoy pool exhaustion', () => {
  // Before the fix, the 19th distinct hostname (pool: 18) or the 763rd
  // distinct IPv4 (pool: 762 RFC 5737 addresses) made sanitize() loop forever.
  const distinct = (r: { mapping: { placeholder: string }[] }) => new Set(r.mapping.map((m) => m.placeholder)).size;

  it('handles more distinct hostnames than the realistic pool holds', () => {
    const src = Array.from({ length: 60 }, (_, i) => `host${i}.uscourts.gov`).join('\n');
    const r = engine.sanitize(src);
    expect(r.mapping).toHaveLength(60);
    expect(distinct(r)).toBe(60);
    // widened decoys stay on reserved example.* domains, so the guard still ignores them
    for (const m of r.mapping) expect(isLikelyDecoy('HOSTNAME', m.placeholder)).toBe(true);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
  });

  it('handles more distinct IPv4 addresses than RFC 5737 has', () => {
    const src = Array.from({ length: 1000 }, (_, i) => `10.9.${i >> 8}.${i & 255}`).join('\n');
    const r = engine.sanitize(src);
    expect(r.mapping).toHaveLength(1000);
    expect(distinct(r)).toBe(1000);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
  });

  it('handles more orgs than the decoy list', () => {
    const terms = Array.from({ length: 15 }, (_, i) => ({ value: `Agency ${String.fromCharCode(65 + i)}`, type: 'ORG' as const }));
    const src = terms.map((t) => t.value).join('; ');
    const r = engine.sanitize(src, { customTerms: terms });
    expect(distinct(r)).toBe(15);
    expect(engine.desanitize(r.sanitized, r.mapping)).toBe(src);
  });

  it('sanitizes a 60k-match log well inside a hook timeout', () => {
    // Overlap resolution and splicing were both quadratic: this took ~32 s.
    const src = Array.from({ length: 20000 }, (_, i) => `conn from 10.${(i >> 8) & 255}.${i & 255}.7 user${i}@corp.com ok`).join('\n');
    const t = Date.now();
    const r = engine.sanitize(src);
    // Generous for slow CI runners; the quadratic version took ~32 s.
    expect(Date.now() - t).toBeLessThan(10000);
    expect(r.sanitized).not.toContain('user42@corp.com');
  }, 20000);

  it('stays unique across calls that share an accumulated priorMapping', () => {
    const hosts = (from: number) => Array.from({ length: 30 }, (_, i) => `h${from + i}.example-corp.com`).join(' ');
    const first = engine.sanitize(hosts(0));
    const second = engine.sanitize(hosts(30), { priorMapping: first.mapping });
    expect(second.mapping).toHaveLength(60);
    expect(distinct(second)).toBe(60);
    expect(engine.desanitize(second.sanitized, second.mapping)).toBe(hosts(30));
  });
});
