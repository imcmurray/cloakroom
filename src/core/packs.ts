// Term-pack format: one shareable JSON dictionary understood by EVERY surface
// (CLI --pack / $CLOAK_PACKS, Claude Code hooks, and the browser app's
// import/export). Parsing and validation live here in core so the semantics —
// including "malformed packs are an error, never a silent skip" — cannot
// drift between surfaces. File/env I/O stays in each surface.

import type { CustomTerm, EntityType } from './types';

export interface TermPack {
  name?: string;
  description?: string;
  /** Literals to ALWAYS replace. Bare strings default to type CUSTOM. */
  customTerms?: Array<string | { value: string; type?: EntityType }>;
  /** Literals to NEVER replace (e.g. public hostnames of your own org). */
  whitelist?: string[];
}

export interface PackContents {
  name?: string;
  customTerms: CustomTerm[];
  whitelist: string[];
}

/**
 * Parse one pack from JSON text. Throws (with a human message) on malformed
 * input — a silently-skipped pack would mean silently-unprotected terms.
 */
export function parseTermPack(jsonText: string): PackContents {
  let pack: TermPack;
  try {
    pack = JSON.parse(jsonText) as TermPack;
  } catch {
    throw new Error('not valid JSON');
  }
  if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new Error('a term pack must be a JSON object');
  }
  if (pack.customTerms !== undefined && !Array.isArray(pack.customTerms)) {
    throw new Error('"customTerms" must be an array');
  }
  if (pack.whitelist !== undefined && !Array.isArray(pack.whitelist)) {
    throw new Error('"whitelist" must be an array');
  }
  const out: PackContents = { name: typeof pack.name === 'string' ? pack.name : undefined, customTerms: [], whitelist: [] };
  for (const t of pack.customTerms ?? []) {
    if (typeof t === 'string' && t.trim()) out.customTerms.push({ value: t.trim() });
    else if (t && typeof t === 'object' && typeof (t as { value?: unknown }).value === 'string' && (t as { value: string }).value.trim()) {
      out.customTerms.push({ value: (t as { value: string }).value.trim(), type: (t as { type?: EntityType }).type });
    } else {
      throw new Error('every customTerms entry must be a string or {value, type?}');
    }
  }
  for (const w of pack.whitelist ?? []) {
    if (typeof w !== 'string' || !w.trim()) throw new Error('every whitelist entry must be a non-empty string');
    out.whitelist.push(w.trim());
  }
  return out;
}

/** Serialize terms + whitelist into the canonical pack JSON (pretty-printed). */
export function serializeTermPack(
  name: string,
  customTerms: CustomTerm[],
  whitelist: string[],
  description?: string,
): string {
  const pack: TermPack = {
    name,
    description:
      description ??
      'Cloakroom term pack — sensitive literals (always replaced) and known-safe literals (never replaced). This file itself lists protected names: treat it as an internal document.',
    customTerms: customTerms.map((t) => (t.type && t.type !== 'CUSTOM' ? { value: t.value, type: t.type } : t.value)),
    whitelist,
  };
  return JSON.stringify(pack, null, 2) + '\n';
}

/**
 * Merge pack contents into existing term/whitelist LISTS, skipping exact
 * duplicates (verbatim-match semantics, same as detection). Returns the merged
 * lists plus how many entries were new vs skipped.
 */
export function mergePack(
  existingTerms: CustomTerm[],
  existingWhitelist: string[],
  pack: PackContents,
): { terms: CustomTerm[]; whitelist: string[]; added: number; skipped: number } {
  const haveTerm = new Set(existingTerms.map((t) => t.value));
  const haveWl = new Set(existingWhitelist);
  let added = 0;
  let skipped = 0;
  const terms = [...existingTerms];
  for (const t of pack.customTerms) {
    if (haveTerm.has(t.value)) skipped++;
    else {
      haveTerm.add(t.value);
      terms.push(t);
      added++;
    }
  }
  const whitelist = [...existingWhitelist];
  for (const w of pack.whitelist) {
    if (haveWl.has(w)) skipped++;
    else {
      haveWl.add(w);
      whitelist.push(w);
      added++;
    }
  }
  return { terms, whitelist, added, skipped };
}
