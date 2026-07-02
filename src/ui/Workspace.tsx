// One document's whole round trip: original → sanitized → AI reply → restored,
// with the review-and-refine interaction (select-to-cloak, click-to-un-cloak).
//
// Extracted from App so the app can hold several documents as tabs: one
// mounted Workspace per tab (inactive ones hidden, never unmounted, so every
// pane, mapping, and half-typed reply survives switching). Shared vocabulary —
// terms, whitelist, mode — lives in App and is passed down; each document's
// mapping is its own, like separate bridge files.

import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { useCloakroom } from './useCloakroom';
import { decideSelectionAction, segmentizeSanitized } from './review';
import type { CustomTerm, EntityType, MappingEntry, RestoreSegment, SanitizeResult } from '../core/types';
import type { DocSnapshot } from './session';
import { Pane } from './Pane';

// One color per entity class — used by both the highlight marks and the legend.
const TYPE_COLORS: Record<string, string> = {
  IPV4: '#5bc8c0', IPV6: '#5bc8c0', MAC: '#5bc8c0',
  EMAIL: '#6ea8fe', URL: '#6ea8fe', HOSTNAME: '#7cc0ff',
  PHONE: '#b794f6',
  SSN: '#e2725b', CREDIT_CARD: '#e8a33d',
  API_KEY: '#c8a24a', AWS_KEY: '#c8a24a', JWT: '#c8a24a',
  UUID: '#8b93a7', HASH: '#8b93a7',
  PATH: '#74c39a',
  PERSON: '#f178b6', ORG: '#d6a4ff',
  CASE_NUMBER: '#f6c453', CASE_NAME: '#7ee0c2',
  CUSTOM: '#9aa7bd',
};
const colorFor = (t?: string): string => (t && TYPE_COLORS[t]) || '#9aa7bd';
const cssVar = (name: string, value: string): CSSProperties => ({ [name]: value }) as CSSProperties;
const trunc = (s: string, n = 28): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Types a user can hand-pick for a selected term — decoys stay shape-matched. */
const CLOAK_TYPES: EntityType[] = ['CUSTOM', 'PERSON', 'ORG', 'CASE_NAME', 'CASE_NUMBER'];

// "value" or "value | ORG" per line.
export function parseTerms(raw: string): CustomTerm[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [value, type] = l.split('|').map((s) => s.trim());
      return { value, type: (type as EntityType) || 'CUSTOM' };
    });
}

export interface WorkspaceProps {
  active: boolean;
  mode: 'realistic' | 'token';
  terms: string;
  whitelist: string;
  setTerms: (v: string) => void;
  setWhitelist: (v: string) => void;
  note: (m: string) => void;
  /** Report this document's state upward (tab label, ticket, session save). */
  onState: (s: { label: string; mapping: MappingEntry[]; snapshot: DocSnapshot }) => void;
  /** Initial content for a fresh tab (the sample, for the first one). */
  seedText?: string;
  /** A bridge imported from disk — this tab starts in restore-only mode. */
  seedBridge?: MappingEntry[];
  /** A restored session snapshot — wins over seedText/seedBridge. */
  seedSnapshot?: DocSnapshot;
}

export function Workspace({
  active, mode, terms, whitelist, setTerms, setWhitelist, note, onState, seedText, seedBridge, seedSnapshot,
}: WorkspaceProps) {
  const { sanitize, desanitize } = useCloakroom();

  const [original, setOriginal] = useState(seedSnapshot?.original ?? seedText ?? '');
  const [result, setResult] = useState<SanitizeResult | null>(
    seedSnapshot ? seedSnapshot.result : seedBridge ? { sanitized: '', mapping: seedBridge, audit: [] } : null,
  );
  const [aiResponse, setAiResponse] = useState(seedSnapshot?.aiResponse ?? '');
  const [restored, setRestored] = useState('');
  const [segments, setSegments] = useState<RestoreSegment[]>([]);
  const [gaps, setGaps] = useState<MappingEntry[]>([]);
  const [imported, setImported] = useState(seedSnapshot?.imported ?? Boolean(seedBridge));
  const [outboundOpen, setOutboundOpen] = useState(seedSnapshot?.outboundOpen ?? !seedBridge);
  const [inboundOpen, setInboundOpen] = useState(seedSnapshot?.inboundOpen ?? Boolean(seedBridge));
  const [sel, setSel] = useState<string | null>(null);
  const [selType, setSelType] = useState<EntityType>('CUSTOM');

  const mapping = result?.mapping ?? [];

  // Lift what the shell needs: tab label, claim ticket, and a full snapshot
  // for the (opt-in, encrypted) session save.
  useEffect(() => {
    const firstLine = original.split('\n').find((l) => l.trim());
    onState({
      label: firstLine ? trunc(firstLine.trim(), 16) : 'Untitled',
      mapping,
      snapshot: { original, aiResponse, result, outboundOpen, inboundOpen, imported },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, result, aiResponse, outboundOpen, inboundOpen, imported]);

  const sanitizedSegs = useMemo(
    () => (result ? segmentizeSanitized(result.sanitized, result.mapping) : []),
    [result],
  );
  const selAction = useMemo(() => (sel !== null ? decideSelectionAction(sel, mapping) : null), [sel, mapping]);

  async function runSanitizeWith(termsStr: string, wlStr: string, quiet = false) {
    const res = await sanitize(original, {
      mode,
      customTerms: parseTerms(termsStr),
      whitelist: wlStr.split('\n').map((s) => s.trim()).filter(Boolean),
    });
    setResult(res);
    setRestored('');
    setSegments([]);
    setGaps([]);
    setImported(false);
    setOutboundOpen(true);
    setInboundOpen(false);
    setSel(null);
    if (!quiet) note(`Sanitized — ${res.mapping.length} item${res.mapping.length === 1 ? '' : 's'} swapped`);
    return res;
  }

  const runSanitize = () => runSanitizeWith(terms, whitelist);

  async function runRestore() {
    if (!mapping.length) return note('Nothing to restore yet — sanitize first');
    const { out, gaps, segments } = await desanitize(aiResponse, mapping);
    setRestored(out);
    setSegments(segments);
    setGaps(gaps);
    note(gaps.length ? `Restored, but ${gaps.length} placeholder(s) were missing from the reply` : 'Restored');
  }

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    note(`Copied ${what}`);
  }

  /** Selection → custom term: append to the shared terms list and re-sanitize. */
  async function cloakSelection(value: string, type: EntityType) {
    if (parseTerms(terms).some((t) => t.value === value)) {
      setSel(null);
      return note('Already in your terms list');
    }
    const nextTerms = (terms.trim() ? terms.replace(/\n*$/, '\n') : '') + `${value} | ${type}`;
    setTerms(nextTerms);
    const res = await runSanitizeWith(nextTerms, whitelist, true);
    const hit = res.mapping.find((m) => m.original === value);
    note(hit ? `Cloaked “${trunc(value)}” — ${hit.count} occurrence${hit.count === 1 ? '' : 's'}` : `Added “${trunc(value)}” to your terms`);
  }

  /** Decoy (or its original) → whitelist: a one-click false-positive fix. */
  async function uncloak(entry: MappingEntry) {
    const nextWl = (whitelist.trim() ? whitelist.replace(/\n*$/, '\n') : '') + entry.original;
    const nextTerms = terms
      .split('\n')
      .filter((l) => l.split('|')[0].trim() !== entry.original)
      .join('\n');
    setWhitelist(nextWl);
    setTerms(nextTerms);
    await runSanitizeWith(nextTerms, nextWl, true);
    note(`Un-cloaked “${trunc(entry.original)}” — added to your never-touch list`);
  }

  function onOriginalSelect(e: SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const text = original.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    if (text.trim()) setSel(text);
  }

  function onSanitizedMouseUp() {
    const text = window.getSelection()?.toString() ?? '';
    if (text.trim()) setSel(text);
  }

  const residualWarning = useMemo(() => {
    if (!result) return false;
    let text = result.sanitized;
    for (const m of result.mapping) text = text.split(m.placeholder).join(' ');
    return /AKIA[0-9A-Z]{16}|sk-(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN/.test(text);
  }, [result]);

  return (
    <section className="stage" style={active ? undefined : { display: 'none' }}>
      {imported && !restored && (
        <div className="banner" role="status">
          <span className="brasstag sm">{mapping.length}</span>
          <div>
            <strong>Bridge loaded.</strong> Your claim ticket is back — paste the AI response that still
            contains the decoys into <em>AI response</em> below, then hit <em>Restore</em> to collect your
            real data. (The original Sanitized text isn’t in a bridge file, so the Outbound panes stay empty.)
          </div>
          <button className="ghost dismiss" aria-label="Dismiss" onClick={() => setImported(false)}>×</button>
        </div>
      )}
      <div className={`lane${outboundOpen ? '' : ' collapsed'}`}>
        <button className="lane-step toggle" onClick={() => setOutboundOpen((o) => !o)} aria-expanded={outboundOpen}>
          <span className="chev" aria-hidden>{outboundOpen ? '▾' : '▸'}</span>
          01 · Outbound
          {!outboundOpen && <span className="lane-hint">— collapsed · expand to sanitize new text</span>}
        </button>
        {outboundOpen && (
          <>
            <div className="panes">
              <Pane label="Original" sub="paste your raw text/logs — select anything we should cloak">
                <textarea value={original} onChange={(e) => setOriginal(e.target.value)}
                  onSelect={onOriginalSelect} onMouseUp={onOriginalSelect} onKeyUp={onOriginalSelect}
                  placeholder="Paste the text this tab should sanitize…" spellCheck={false} />
              </Pane>
              <div className="arrow" aria-hidden>→</div>
              <Pane label="Sanitized" sub="tinted = decoyed · select missed text to cloak it · click a decoy to un-cloak"
                action={result?.sanitized && <button className="ghost" onClick={() => { copy(result.sanitized, 'sanitized'); setInboundOpen(true); }}>Copy</button>}>
                <pre className="readout" onMouseUp={onSanitizedMouseUp}>
                  {result ? (
                    sanitizedSegs.map((s, i) =>
                      s.entry ? (
                        <mark key={i} className="hl decoy" style={cssVar('--c', colorFor(s.entry.type))}
                          title={`${s.entry.type} decoy — click to un-cloak`}
                          onClick={() => uncloak(s.entry!)}>
                          {s.text}
                        </mark>
                      ) : (
                        <span key={i}>{s.text}</span>
                      ),
                    )
                  ) : (
                    <span className="placeholder">Run sanitize to see decoyed output…</span>
                  )}
                </pre>
              </Pane>
            </div>
            {sel !== null && selAction && (
              <div className="actionbar" role="toolbar" aria-label="Selection actions">
                {selAction.kind === 'cloak' && (
                  <>
                    <span className="sel-quote">“{trunc(selAction.value, 44)}”</span>
                    <label className="sel-as">
                      as
                      <select value={selType} onChange={(e) => setSelType(e.target.value as EntityType)}>
                        {CLOAK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </label>
                    <button className="primary sm" onClick={() => cloakSelection(selAction.value, selType)}>
                      Cloak everywhere
                    </button>
                  </>
                )}
                {selAction.kind === 'uncloak' && (
                  <>
                    <span className="sel-quote">
                      “{trunc(selAction.entry.original, 34)}” <span className="to">⇄</span> <code>{trunc(selAction.entry.placeholder, 34)}</code>
                    </span>
                    <button className="primary sm" onClick={() => uncloak(selAction.entry)}>
                      Un-cloak (never touch)
                    </button>
                  </>
                )}
                {selAction.kind === 'blocked' && <span className="sel-blocked">{selAction.reason}</span>}
                <button className="ghost dismiss" aria-label="Dismiss" onClick={() => setSel(null)}>×</button>
              </div>
            )}
            <button className="primary" onClick={runSanitize}>Sanitize</button>
            {residualWarning && <p className="warn">Heads up: a secret-shaped string may still be present. Review before copying.</p>}
          </>
        )}
      </div>

      <div className={`lane${inboundOpen ? '' : ' collapsed'}`}>
        <button className="lane-step toggle" onClick={() => setInboundOpen((o) => !o)} aria-expanded={inboundOpen}>
          <span className="chev" aria-hidden>{inboundOpen ? '▾' : '▸'}</span>
          02 · Inbound
          {!inboundOpen && <span className="lane-hint">— collapsed · expand to paste the AI response</span>}
        </button>
        {inboundOpen && (
          <>
            <div className="panes">
              <Pane label="AI response" sub="paste what the model gave back"
                action={result?.sanitized && (
                  <button className="ghost" title="Demo the round trip without leaving the page"
                    onClick={() => { setAiResponse(result.sanitized); note('Loaded sanitized text as a test reply'); }}>
                    Use sanitized
                  </button>
                )}>
                <textarea value={aiResponse} onChange={(e) => setAiResponse(e.target.value)} spellCheck={false}
                  placeholder="Paste the LLM's reply (with decoys) here…" />
              </Pane>
              <div className="arrow" aria-hidden>→</div>
              <Pane label="Restored" sub="your real data back in place"
                action={restored && <button className="ghost" onClick={() => copy(restored, 'restored')}>Copy</button>}>
                {segments.some((s) => s.restored) && (
                  <div className="legend" aria-label="Restored value types">
                    {[...new Set(segments.filter((s) => s.restored).map((s) => s.type))].map((t) => (
                      <span className="chip" key={t}>
                        <i style={{ background: colorFor(t) }} aria-hidden />
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <pre className="readout restored">
                  {segments.length ? (
                    segments.map((s, i) =>
                      s.restored ? (
                        <mark className="hl" key={i} title={s.type} style={cssVar('--c', colorFor(s.type))}>
                          {s.text}
                        </mark>
                      ) : (
                        <span key={i}>{s.text}</span>
                      ),
                    )
                  ) : (
                    <span className="placeholder">Restore to bring your real values back…</span>
                  )}
                </pre>
              </Pane>
            </div>
            <button className="primary" onClick={runRestore}>Restore</button>
            {gaps.length > 0 && (
              <p className="warn">The model dropped {gaps.length} placeholder(s): {gaps.map((g) => g.placeholder).join(', ')}. Those values couldn’t be re-anchored.</p>
            )}
          </>
        )}
      </div>

      {result && result.audit.length > 0 && (
        <div className="audit">
          <div className="eyebrow">What was swapped <span className="hint">(visible only to you)</span></div>
          <ul>
            {result.audit.map((a) => {
              const entry = mapping.find((m) => m.placeholder === a.placeholder);
              return (
                <li key={a.placeholder}>
                  <span className="tag">{a.type}</span>
                  <span className="mask">{a.preview}</span>
                  <span className="to">→</span>
                  <code>{a.placeholder}</code>
                  {a.count > 1 && <span className="count">×{a.count}</span>}
                  {entry && (
                    <button className="ghost sm uncloak" title="False positive? Whitelist it and re-sanitize"
                      onClick={() => uncloak(entry)}>
                      un-cloak
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
