// Pattern detectors. Each yields RawMatch[]; the engine resolves overlaps.
// Ordering note: high-specificity detectors (AWS key, JWT, UUID) get higher
// confidence than greedy generic ones (HASH, PATH) so they win ties.

import type { EntityType, RawMatch, CustomTerm } from './types';

interface DetectorDef {
  type: EntityType;
  name: string;
  re: RegExp; // MUST be global
  confidence: number;
  validate?: (m: string) => boolean;
  /** Replace only this capture group (needs the `d` flag), e.g. the value in `password=…`. */
  group?: number;
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Comprehensive IPv6 matcher (full, leading/trailing ::, and all compressed forms).
// Longer branches first so the engine matches the whole address, not a prefix.
function IPV6_RE(): RegExp {
  const H = '[0-9a-fA-F]{1,4}';
  const body = [
    `(?:${H}:){7}${H}`, // 1:2:3:4:5:6:7:8
    `(?:${H}:){1,7}:`, // 1::  ...  1:2:3:4:5:6:7::
    `(?:${H}:){1,6}:${H}`, // 1::8 ... 1:2:3:4:5:6::8
    `(?:${H}:){1,5}(?::${H}){1,2}`, // 1::7:8 ...
    `(?:${H}:){1,4}(?::${H}){1,3}`,
    `(?:${H}:){1,3}(?::${H}){1,4}`,
    `(?:${H}:){1,2}(?::${H}){1,5}`,
    `${H}:(?::${H}){1,6}`, // 1::3:4:5:6:7:8
    `:(?:(?::${H}){1,7}|:)`, // ::2:3:4:5:6:7:8 / ::
  ].join('|');
  // Lookarounds (not \b) so leading-"::" forms match and we don't split on ':'.
  return new RegExp(`(?<![\\w:])(?:${body})(?![\\w:])`, 'g');
}

// Key names that introduce a secret value in `key: value` / `key=value` text.
const SECRET_KEY = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)';

// Order matters only for readability; confidence drives conflict resolution.
const DETECTORS: DetectorDef[] = [
  { type: 'AWS_KEY', name: 'aws-access-key', confidence: 0.99, re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Federal CM/ECF case numbers: office:yy-type-number(-judge initials), e.g. 2:23-cv-00456-DBB
  { type: 'CASE_NUMBER', name: 'fed-case-no', confidence: 0.93, re: /\b\d:\d{2}-[a-z]{2}-\d{3,6}(?:-[A-Za-z]{1,4})*\b/g },
  // Bankruptcy / adversary short form, e.g. 23-12345 or 23-02001
  { type: 'CASE_NUMBER', name: 'bk-case-no', confidence: 0.55, re: /\b\d{2}-\d{5}\b/g },
  // Captions: "Smith v. Jones" / "Smith vs. Jones"
  { type: 'CASE_NAME', name: 'caption-v', confidence: 0.82, re: /\b[A-Z][A-Za-z.'&-]+(?: [A-Z][A-Za-z.'&-]+){0,3} vs?\.? [A-Z][A-Za-z.'&-]+(?: [A-Z][A-Za-z.'&-]+){0,3}\b/g },
  // Bankruptcy captions: "In re Doe"
  { type: 'CASE_NAME', name: 'caption-inre', confidence: 0.75, re: /\bIn re:? [A-Z][A-Za-z.'&-]+(?: [A-Z][A-Za-z.'&-]+){0,3}\b/g },
  { type: 'JWT', name: 'jwt', confidence: 0.97, re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'API_KEY', name: 'prefixed-secret', confidence: 0.95, re: /\b(?:sk|pk|rk|sk-live|sk-test|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g },
  // Vendor tokens whose bodies carry their own - / _ separators, which the
  // pattern above can't span (it missed every one of these).
  { type: 'API_KEY', name: 'anthropic-openai-key', confidence: 0.97, re: /\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },
  { type: 'API_KEY', name: 'stripe-key', confidence: 0.97, re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { type: 'API_KEY', name: 'github-pat', confidence: 0.97, re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { type: 'API_KEY', name: 'gitlab-pat', confidence: 0.97, re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { type: 'API_KEY', name: 'npm-token', confidence: 0.97, re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: 'API_KEY', name: 'google-api-key', confidence: 0.97, re: /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  { type: 'PRIVATE_KEY', name: 'pem-private-key', confidence: 0.99, re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  // `password=…`, `"client_secret": "…"`, `DB_PASSWORD: …`, `aws_secret_access_key = …`.
  // Only the VALUE is replaced, so the key name stays readable for the model.
  // Quoted values may hold any character; unquoted ones skip what is plainly
  // code (`token: string`, `pass = prompt(…)`, `$VAR` / `${VAR}` / `process.env.X`) so
  // the guard doesn't deny every source file that declares a `token` field.
  {
    type: 'SECRET',
    name: 'secret-assignment-quoted',
    confidence: 0.85,
    group: 2,
    re: new RegExp(`${SECRET_KEY}["']?\\s*[:=]\\s*(["'\`])(?!\\$\\{)([^"'\`\\n«»]{6,})\\1`, 'gid'),
  },
  {
    type: 'SECRET',
    name: 'secret-assignment',
    confidence: 0.85,
    group: 1,
    re: new RegExp(
      `${SECRET_KEY}["']?\\s*[:=]\\s*(?![$"'\`]|process\\.env\\b|(?:string|number|boolean|undefined|null|unknown|true|false|any|never|void)\\b)([^\\s"'\`,;«»(){}<>\\[\\]]{6,})(?![\\w.(])`,
      'gid',
    ),
  },
  // Password in URI userinfo: postgres://user:PASSWORD@host. Outranks EMAIL,
  // which would otherwise claim `PASSWORD@host` and leave the shape garbled.
  { type: 'SECRET', name: 'uri-password', confidence: 0.96, group: 1, re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gid },
  { type: 'UUID', name: 'uuid', confidence: 0.9, re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { type: 'EMAIL', name: 'email', confidence: 0.95, re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'IPV4', name: 'ipv4', confidence: 0.9, re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    type: 'IPV6',
    name: 'ipv6',
    confidence: 0.85,
    // Full + all compressed (::) forms. Bounded by non-hex/non-colon so it grabs the
    // WHOLE address (no partial `fe80::` leaks) and won't fire on clock times like
    // 14:22:01 (3 single-colon groups is not a valid IPv6 shape, so nothing matches).
    re: IPV6_RE(),
    // Guard against a bare "::" with no hex at all.
    validate: (m) => /[0-9a-fA-F]/.test(m.replace(/:/g, '')),
  },
  { type: 'MAC', name: 'mac', confidence: 0.88, re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
  { type: 'SSN', name: 'ssn', confidence: 0.8, re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // Anchored to start AND end on a digit so a trailing space/hyphen is never
  // swallowed into the match (which would mash the decoy into the next word).
  { type: 'CREDIT_CARD', name: 'credit-card', confidence: 0.92, re: /\b\d(?:[ -]?\d){12,18}\b/g, validate: luhnValid },
  { type: 'PHONE', name: 'phone', confidence: 0.6, re: /(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g },
  { type: 'URL', name: 'url', confidence: 0.7, re: /\bhttps?:\/\/[^\s<>"'`]+/g },
  // Bare websites / hostnames, e.g. www.foo.com, example-corp.com, ecf.utd.uscourts.gov
  {
    type: 'HOSTNAME',
    name: 'website',
    confidence: 0.62,
    re: /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|edu|io|co|us|uk|ca|gov|mil|info|biz|dev|app|courts|uscourts\.gov)\b/gi,
    validate: (m) => /[a-z]/i.test(m) && !/^\d+\./.test(m),
  },
  { type: 'PATH', name: 'win-path', confidence: 0.6, re: /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\?)+/g },
  { type: 'PATH', name: 'unix-path', confidence: 0.55, re: /(?:\/(?:home|users|var|etc|opt|srv|mnt|root|usr)\/)[^\s:()"'`]+/gi },
  { type: 'HASH', name: 'hex-hash', confidence: 0.5, re: /\b[0-9a-f]{32}(?:[0-9a-f]{8}(?:[0-9a-f]{24})?)?\b/g, validate: (m) => [32, 40, 64].includes(m.length) },
];

function runDetector(text: string, d: DetectorDef): RawMatch[] {
  const out: RawMatch[] = [];
  d.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = d.re.exec(text)) !== null) {
    const value = d.group ? m[d.group] : m[0];
    const start = d.group ? m.indices![d.group]![0] : m.index;
    if (m.index === d.re.lastIndex) d.re.lastIndex++; // zero-width guard
    if (d.validate && !d.validate(value)) continue;
    out.push({ type: d.type, value, start, end: start + value.length, confidence: d.confidence, detector: d.name });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal user-declared terms (names, company, codenames) — highest confidence, matched verbatim. */
export function detectCustomTerms(text: string, terms: CustomTerm[]): RawMatch[] {
  const out: RawMatch[] = [];
  for (const t of terms) {
    if (!t.value) continue;
    const re = new RegExp(`(?<![\\w])${escapeRe(t.value)}(?![\\w])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({
        type: t.type ?? 'CUSTOM',
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: 1, // user said so — never lose to a built-in
        detector: 'custom-term',
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

export function detectAll(text: string, customTerms: CustomTerm[] = []): RawMatch[] {
  const matches = [...detectCustomTerms(text, customTerms)];
  for (const d of DETECTORS) matches.push(...runDetector(text, d));
  return matches;
}

/**
 * Resolve overlaps: prefer higher confidence, then longer span, then earlier start.
 * Greedy interval selection over a sorted list.
 */
export function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort(
    (a, b) => b.confidence - a.confidence || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  // Track claimed characters instead of testing each candidate against every
  // match already taken: that was quadratic, and a 60k-match log took 10 s —
  // long enough to push a Claude Code hook past its timeout.
  const claimed = new Uint8Array(matches.reduce((max, m) => Math.max(max, m.end), 0));
  const taken: RawMatch[] = [];
  for (const m of sorted) {
    if (claimed.subarray(m.start, m.end).includes(1)) continue;
    claimed.fill(1, m.start, m.end);
    taken.push(m);
  }
  return taken.sort((a, b) => a.start - b.start);
}
