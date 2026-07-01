// Deterministic, format-preserving fake generators.
//
// KEY INSIGHT: we draw fakes from ranges that are RESERVED for documentation /
// testing, so the output is realistic enough for an LLM to reason about, yet
// provably not a real-world value:
//   - IPv4:  RFC 5737  (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
//   - Email: RFC 2606  (example.com / .test)
//   - Phone: 555-0100..555-0199 (reserved for fiction)
//   - SSN:   area 900-999 (never issued by the SSA)
//   - Card:  Luhn-valid test BIN 4000 (Visa test space)
//
// Determinism: same (type, original, seed) → same fake, so a value that appears
// twice maps to one placeholder even without the cache. Pure functions, no crypto
// randomness needed — these are decoys, not secrets.

import type { EntityType } from './types';

function xfnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(type: EntityType, original: string, seed = 0): () => number {
  return mulberry32(xfnv1a(`${type}:${original}`) ^ (seed | 0));
}

const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
const HEXLC = '0123456789abcdef';

/** Replace each char with a random one of the same class; keep separators/length/shape. */
function mimic(value: string, rng: () => number, hexAware = false): string {
  let out = '';
  for (const ch of value) {
    if (ch >= '0' && ch <= '9') out += DIGIT[int(rng, 0, 9)];
    else if (ch >= 'a' && ch <= 'z') out += hexAware && ch <= 'f' ? HEXLC[int(rng, 0, 15)] : LOWER[int(rng, 0, 25)];
    else if (ch >= 'A' && ch <= 'Z') out += UPPER[int(rng, 0, 25)];
    else out += ch; // keep '-', ':', '.', '_', '/', etc.
  }
  return out;
}

const FIRST = ['Alex', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Sam', 'Jamie', 'Avery', 'Quinn', 'Drew', 'Reese'];
const LAST = ['Rivera', 'Chen', 'Nguyen', 'Patel', 'Kim', 'Garcia', 'Okafor', 'Larsen', 'Romano', 'Haddad', 'Novak', 'Flores'];
const ORGS = ['Acme Corp', 'Initech', 'Globex', 'Umbra Systems', 'Cygnus Labs', 'Northwind Traders', 'Soylent Inc', 'Hooli', 'Vandelay Industries', 'Stark Solutions'];

function luhnDigit(digits: string): string {
  let sum = 0;
  // digits are the n-1 leading digits; check digit makes total % 10 === 0
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    let d = rev[i].charCodeAt(0) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Is this detected value one of OUR OWN reserved-range decoys? Used by scanners
 * (e.g. the Claude Code output guard) so already-sanitized text isn't flagged
 * as leaking secrets. Only types whose decoys are structurally recognizable are
 * covered — reserved doc ranges that real-world data can't legitimately use.
 * Conservative by design: a `false` here just means "treat as sensitive".
 */
export function isLikelyDecoy(type: EntityType, value: string): boolean {
  switch (type) {
    case 'IPV4':
      return /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(value); // RFC 5737
    case 'IPV6':
      return /^2001:db8:/i.test(value); // RFC 3849
    case 'EMAIL':
      return /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$|@[a-z0-9-]+\.test$/i.test(value); // RFC 2606
    case 'HOSTNAME':
    case 'URL':
      return /(?:^|\/\/|\.)example\.(?:com|org|net)(?:[/:]|$)/i.test(value) || /\.test$/i.test(value);
    case 'SSN':
      return /^9\d{2}-\d{2}-\d{4}$/.test(value); // area 900-999 never issued
    case 'PHONE':
      return /555-?01\d{2}$/.test(value); // 555-0100..0199 reserved for fiction
    default:
      return false; // mimic-style decoys (keys, hashes, cards) are indistinguishable
  }
}

/** Produce a realistic, reserved-range fake for a given match. */
export function generateRealistic(type: EntityType, original: string, seed = 0): string {
  const rng = rngFor(type, original, seed);
  switch (type) {
    case 'IPV4': {
      const blocks = ['192.0.2', '198.51.100', '203.0.113'];
      return `${pick(rng, blocks)}.${int(rng, 1, 254)}`;
    }
    case 'IPV6':
      return `2001:db8:${mimic('0000:0000:0000:0000', rng, true).slice(0, 9)}::${int(rng, 1, 9999)}`;
    case 'MAC':
      return mimic('00:00:00:00:00:00', rng, true);
    case 'EMAIL': {
      const host = pick(rng, ['example.com', 'example.org', 'example.net']);
      return `${pick(rng, FIRST).toLowerCase()}.${pick(rng, LAST).toLowerCase()}@${host}`;
    }
    case 'PHONE': {
      const area = int(rng, 200, 989);
      const line = int(rng, 100, 199); // 555-01xx reserved for fiction
      return `(${area}) 555-0${line}`;
    }
    case 'SSN':
      return `9${int(rng, 0, 9)}${int(rng, 0, 9)}-${int(rng, 10, 99)}-${int(rng, 1000, 9999)}`;
    case 'CREDIT_CARD': {
      const nDigits = (original.match(/\d/g) || []).length || 16;
      let body = '4'; // Visa test BIN
      while (body.length < nDigits - 1) body += int(rng, 0, 9);
      return body + luhnDigit(body);
    }
    case 'PERSON':
      return `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    case 'ORG':
      return pick(rng, ORGS);
    case 'CASE_NUMBER':
      // Keep the structure (office:yy-type-number-initials); randomize only digits and judge initials.
      return original.replace(/\d/g, () => DIGIT[int(rng, 0, 9)]).replace(/[A-Z]/g, () => UPPER[int(rng, 0, 25)]);
    case 'CASE_NAME':
      return /^In re/i.test(original)
        ? `In re ${pick(rng, FIRST)} ${pick(rng, LAST)}`
        : `${pick(rng, LAST)} v. ${pick(rng, LAST)}`;
    case 'AWS_KEY': {
      const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32-ish, like a real key body
      let s = 'AKIA';
      for (let i = 0; i < 16; i++) s += cs[int(rng, 0, cs.length - 1)];
      return s;
    }
    case 'JWT':
    case 'API_KEY':
    case 'HASH':
    case 'UUID':
      return mimic(original, rng, type === 'HASH' || type === 'UUID');
    case 'URL':
      return `https://example.com/${mimic('xxxxxxxx', rng)}`;
    case 'HOSTNAME': {
      // Always resolve to a reserved example.* domain so the decoy can't be a real site.
      const label = pick(rng, ['acme', 'contoso', 'northwind', 'globex', 'umbra', 'initech']);
      const tld = pick(rng, ['example.com', 'example.org', 'example.net']);
      return (original.toLowerCase().startsWith('www.') ? 'www.' : '') + `${label}.${tld}`;
    }
    case 'PATH':
      return original.replace(/[^/\\.:]+/g, (seg) => (seg.length > 1 ? mimic(seg, rng) : seg));
    default:
      return mimic(original, rng);
  }
}
