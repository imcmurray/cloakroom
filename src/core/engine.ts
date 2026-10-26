// The sanitize / desanitize engine. Pure & synchronous; safe for a Web Worker.

import { detectAll, resolveOverlaps } from './detectors';
import { generateRealistic, widenDecoy } from './generators';
import type {
  AuditItem,
  EntityType,
  MappingEntry,
  RawMatch,
  RestoreSegment,
  SanitizeOptions,
  SanitizeResult,
} from './types';

/** Random decoy re-rolls before falling back to a counter-widened decoy. */
const MAX_REROLLS = 64;

function maskPreview(value: string): string {
  if (value.length <= 4) return value[0] + '█'.repeat(Math.max(1, value.length - 1));
  return value.slice(0, 2) + '█'.repeat(Math.min(8, value.length - 4)) + value.slice(-2);
}

/**
 * Consistency-cache key for a (type, value) pair. EntityType never contains a
 * space, so a single-space separator is unambiguous. Every call site builds the
 * key through THIS function so the separator can never diverge between seeding a
 * prior mapping and looking up a fresh match — an earlier version inlined the
 * key at two sites and one carried a stray separator byte, so they silently
 * never matched and cross-call consistency broke.
 */
function mapKey(type: EntityType, value: string): string {
  return `${type} ${value}`;
}

export class CloakroomEngine {
  /**
   * Replace detected sensitive values with consistent placeholders.
   * Same input value → same placeholder (relationships preserved).
   */
  sanitize(text: string, opts: SanitizeOptions = {}): SanitizeResult {
    const mode = opts.mode ?? 'realistic';
    const minConf = opts.minConfidence ?? 0.5;
    const seed = opts.seed ?? 0;
    const whitelist = new Set(opts.whitelist ?? []);

    let matches = detectAll(text, opts.customTerms ?? []).filter((m) => m.confidence >= minConf);
    if (opts.enabledTypes) {
      const allow = new Set(opts.enabledTypes);
      matches = matches.filter((m) => allow.has(m.type) || m.detector === 'custom-term');
    }
    // Whitelisted matches stay in until AFTER overlap resolution so they still
    // WIN their span — removing them first would hand their territory to
    // lower-confidence overlapping detectors (e.g. the boundary-less PHONE
    // regex nibbling digits out of a whitelisted UUID). Whitelist means
    // "detected but never replaced", not "never detected".
    matches = resolveOverlaps(matches);
    matches = matches.filter((m) => !whitelist.has(m.value));

    // original -> placeholder (consistency cache, keyed by type+value)
    const fwd = new Map<string, MappingEntry>();
    const usedPlaceholders = new Set<string>();
    const tokenCounters = new Map<EntityType, number>();

    // Seed from a prior mapping so repeated values stay consistent across calls
    // (accumulating session bridge). Existing originals keep their placeholder;
    // all prior placeholders are reserved; token counters resume past the max.
    for (const e of opts.priorMapping ?? []) {
      fwd.set(mapKey(e.type, e.original), { ...e });
      usedPlaceholders.add(e.placeholder);
      const tok = /_(\d+)»$/.exec(e.placeholder);
      if (tok) {
        const n = Number(tok[1]);
        tokenCounters.set(e.type, Math.max(tokenCounters.get(e.type) ?? 0, n));
      }
    }

    const assign = (m: RawMatch): MappingEntry => {
      const key = mapKey(m.type, m.value);
      const existing = fwd.get(key);
      if (existing) {
        existing.count++;
        return existing;
      }
      const placeholder = this.makePlaceholder(m, mode, seed, usedPlaceholders, tokenCounters);
      usedPlaceholders.add(placeholder);
      const entry: MappingEntry = { type: m.type, original: m.value, placeholder, count: 1 };
      fwd.set(key, entry);
      return entry;
    };

    // Assemble left-to-right from the untouched gaps (matches are sorted and
    // non-overlapping). Re-slicing the whole string per match was quadratic.
    const parts: string[] = [];
    let last = 0;
    for (const m of matches) {
      parts.push(text.slice(last, m.start), assign(m).placeholder);
      last = m.end;
    }
    parts.push(text.slice(last));
    const out = parts.join('');

    const mapping = [...fwd.values()];
    const audit: AuditItem[] = mapping.map((e) => ({
      type: e.type,
      placeholder: e.placeholder,
      detector: 'mixed',
      confidence: 1,
      count: e.count,
      preview: maskPreview(e.original),
    }));

    return { sanitized: out, mapping, audit };
  }

  private makePlaceholder(
    m: RawMatch,
    mode: 'realistic' | 'token',
    seed: number,
    used: Set<string>,
    counters: Map<EntityType, number>,
  ): string {
    if (mode === 'token') {
      const n = (counters.get(m.type) ?? 0) + 1;
      counters.set(m.type, n);
      return `«${m.type}_${n}»`;
    }
    // realistic: re-roll with a salt nudge until unique — but only a bounded
    // number of times. Some decoy pools are small enough to exhaust (19 distinct
    // hostnames used to do it), and an unbounded re-roll then spins forever; in
    // a Claude Code hook that means a timeout and the raw output going through.
    let candidate = generateRealistic(m.type, m.value, seed);
    for (let salt = 1; salt <= MAX_REROLLS && (used.has(candidate) || candidate === m.value); salt++) {
      candidate = generateRealistic(m.type, m.value + '#' + salt, seed);
    }
    // Pool exhausted: widen with a per-type counter, which always terminates.
    const base = candidate;
    while (used.has(candidate) || candidate === m.value) {
      const n = (counters.get(m.type) ?? 0) + 1;
      counters.set(m.type, n);
      candidate = widenDecoy(m.type, base, n);
    }
    return candidate;
  }

  /**
   * Restore originals from a sanitized/AI-returned text.
   * Single-pass alternation (longest placeholder first) so a restored original
   * that happens to contain another placeholder string is never re-substituted.
   */
  desanitize(text: string, mapping: MappingEntry[]): string {
    return this.desanitizeSegments(text, mapping)
      .map((s) => s.text)
      .join('');
  }

  /**
   * Like desanitize(), but returns the text split into segments so the UI can
   * highlight exactly which spans were re-inflated. Same single-pass,
   * longest-first matching — so the highlight and the restored string never diverge.
   */
  desanitizeSegments(text: string, mapping: MappingEntry[]): RestoreSegment[] {
    if (mapping.length === 0) return [{ text, restored: false }];
    const byPlaceholder = new Map(mapping.map((e) => [e.placeholder, e]));
    const alternation = [...byPlaceholder.keys()]
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const re = new RegExp(alternation, 'g');

    const segs: RestoreSegment[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segs.push({ text: text.slice(last, m.index), restored: false });
      const entry = byPlaceholder.get(m[0])!;
      segs.push({ text: entry.original, restored: true, type: entry.type });
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < text.length) segs.push({ text: text.slice(last), restored: false });
    return segs;
  }

  /** Diagnostics: which originals never reappeared in the AI response (context loss). */
  reverseGaps(aiResponse: string, mapping: MappingEntry[]): MappingEntry[] {
    return mapping.filter((e) => !aiResponse.includes(e.placeholder));
  }
}

export const engine = new CloakroomEngine();
