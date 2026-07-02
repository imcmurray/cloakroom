// Pure helpers for the review-and-refine interaction on the Outbound lane:
// paint decoys in the sanitized pane, and decide what a text selection can do
// (cloak a missed term / un-cloak a false positive / nothing).
//
// Deliberately DOM-free so it unit-tests in node. The design premise: users
// never EDIT sanitized text directly — a hand edit has no mapping entry, so it
// can't be restored and silently breaks occurrence consistency. Every change
// goes through the engine as a term or whitelist entry instead.

import type { MappingEntry } from '../core/types';

export interface SanitizedSegment {
  text: string;
  /** The mapping entry when this segment is a decoy; undefined for untouched text. */
  entry?: MappingEntry;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Split sanitized output into untouched-text and decoy segments (longest
 * placeholder first, same discipline as the engine's desanitizeSegments) so
 * the UI can highlight exactly what was swapped — and, by omission, what wasn't.
 */
export function segmentizeSanitized(text: string, mapping: MappingEntry[]): SanitizedSegment[] {
  if (!mapping.length || !text) return [{ text }];
  const byPlaceholder = new Map(mapping.map((e) => [e.placeholder, e]));
  const re = new RegExp(
    [...byPlaceholder.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'),
    'g',
  );
  const out: SanitizedSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], entry: byPlaceholder.get(m[0])! });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export type SelectionAction =
  | { kind: 'cloak'; value: string }
  | { kind: 'uncloak'; entry: MappingEntry }
  | { kind: 'blocked'; reason: string };

/**
 * What can we do with a selection?
 * - exactly a decoy (or its original) → un-cloak (whitelist the original)
 * - plain leftover text → cloak it everywhere
 * - selections that CROSS a decoy, span lines, or contain the term-syntax
 *   separator can't become a clean term → blocked, with a human reason.
 */
export function decideSelectionAction(raw: string, mapping: MappingEntry[]): SelectionAction {
  const value = raw.trim();
  if (!value) return { kind: 'blocked', reason: 'empty selection' };

  const asDecoy = mapping.find((e) => e.placeholder === value);
  if (asDecoy) return { kind: 'uncloak', entry: asDecoy };
  const asOriginal = mapping.find((e) => e.original === value);
  if (asOriginal) return { kind: 'uncloak', entry: asOriginal };

  if (/\r|\n/.test(value)) {
    return { kind: 'blocked', reason: 'select a single phrase (terms are one line each)' };
  }
  if (value.includes('|')) {
    return { kind: 'blocked', reason: '“|” can’t be part of a term (it separates the type)' };
  }
  const crossed = mapping.find((e) => value.includes(e.placeholder) || e.placeholder.includes(value));
  if (crossed) {
    return { kind: 'blocked', reason: 'selection overlaps a decoy — select only the missed text' };
  }
  return { kind: 'cloak', value };
}
