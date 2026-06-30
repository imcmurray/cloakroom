import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useCloakroom } from './useCloakroom';
import { encryptBridge, decryptBridge } from '../core/crypto';
import type { CustomTerm, EntityType, MappingEntry, RestoreSegment, SanitizeResult } from '../core/types';

const SAMPLE = `[2026-06-30 14:22:01] ERROR ecf: filing failed for jane.doe@example-corp.com
  client 192.168.1.100 (seen again at 192.168.1.100), gateway 10.20.30.40
  token=sk-live_AB12cd34EF56gh78IJ90kl12  aws=AKIAIOSFODNN7EXAMPLE
  user "Jane Doe" employer "Northwind Trading" ssn 521-22-1234
  matter "Smith v. Jones" case 2:23-cv-00456-DBB; bankruptcy In re Doe 23-12345
  card 4111 1111 1111 1111  trace 550e8400-e29b-41d4-a716-446655440000`;

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
// Set a CSS custom property from JS (typed so TS accepts the `--c` name).
const cssVar = (name: string, value: string): CSSProperties => ({ [name]: value }) as CSSProperties;

// "value" or "value | ORG" per line.
function parseTerms(raw: string): CustomTerm[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [value, type] = l.split('|').map((s) => s.trim());
      return { value, type: (type as EntityType) || 'CUSTOM' };
    });
}

export function App() {
  const { sanitize, desanitize } = useCloakroom();

  const [mode, setMode] = useState<'realistic' | 'token'>('realistic');
  const [original, setOriginal] = useState(SAMPLE);
  const [terms, setTerms] = useState('Jane Doe | PERSON\nNorthwind Trading | ORG');
  const [whitelist, setWhitelist] = useState('127.0.0.1');

  const [result, setResult] = useState<SanitizeResult | null>(null);
  const [aiResponse, setAiResponse] = useState('');
  const [restored, setRestored] = useState('');
  const [segments, setSegments] = useState<RestoreSegment[]>([]);
  const [gaps, setGaps] = useState<MappingEntry[]>([]);
  const [imported, setImported] = useState(false);
  const [outboundOpen, setOutboundOpen] = useState(true);
  const [inboundOpen, setInboundOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const mapping = result?.mapping ?? [];

  const note = (m: string) => {
    setFlash(m);
    window.setTimeout(() => setFlash(null), 2200);
  };

  async function runSanitize() {
    const res = await sanitize(original, {
      mode,
      customTerms: parseTerms(terms),
      whitelist: whitelist.split('\n').map((s) => s.trim()).filter(Boolean),
    });
    setResult(res);
    setRestored('');
    setSegments([]);
    setGaps([]);
    setImported(false);
    setOutboundOpen(true);
    setInboundOpen(false);
    note(`Sanitized — ${res.mapping.length} item${res.mapping.length === 1 ? '' : 's'} swapped`);
  }

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

  async function exportBridge() {
    if (!mapping.length) return note('Sanitize something first');
    const pass = window.prompt('Passphrase to encrypt this bridge file (AES-256-GCM):');
    if (!pass) return;
    const blob = await encryptBridge(mapping, pass, mode);
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloakroom-${new Date().toISOString().slice(0, 10)}.cloak`;
    a.click();
    URL.revokeObjectURL(url);
    note('Bridge file downloaded');
  }

  function importBridge(file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      const pass = window.prompt('Passphrase to decrypt this bridge file:');
      if (!pass) return;
      try {
        const bf = await decryptBridge(String(reader.result), pass);
        setResult({ sanitized: '', mapping: bf.mapping, audit: [] });
        setMode(bf.mode);
        setRestored('');
        setSegments([]);
        setGaps([]);
        setImported(true);
        setOutboundOpen(false);
        setInboundOpen(true);
        note(`Bridge loaded — ${bf.mapping.length} mappings ready to restore`);
      } catch {
        note('Wrong passphrase or corrupt file');
      }
    };
    reader.readAsText(file);
  }

  const residualWarning = useMemo(() => {
    // Pre-copy check: leftover secret-shaped strings — but ignore our OWN decoys,
    // which are intentionally secret-shaped. Strip placeholders first, then scan.
    if (!result) return false;
    let text = result.sanitized;
    for (const m of result.mapping) text = text.split(m.placeholder).join(' ');
    return /AKIA[0-9A-Z]{16}|sk-(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN/.test(text);
  }, [result]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <span className="bar" aria-hidden />
          Cloakroom
        </div>
        <p className="tagline">Check your secrets at the door. Get them back on the way out.</p>
        <div className="modeswitch" role="group" aria-label="Replacement mode">
          <button className={mode === 'realistic' ? 'on' : ''} onClick={() => setMode('realistic')}>
            Realistic decoys
          </button>
          <button className={mode === 'token' ? 'on' : ''} onClick={() => setMode('token')}>
            Tokens
          </button>
        </div>
      </header>

      <main className="grid">
        <aside className="rail">
          <section className="card">
            <label className="eyebrow" htmlFor="terms">Your sensitive terms</label>
            <p className="hint">
              Things only you know are sensitive — names, employers, client/matter names, case captions,
              project codenames. Structured data (IPs, emails, keys, SSNs, case numbers) is caught
              automatically; free-text proper nouns aren’t, so you list them here.
            </p>
            <details className="help">
              <summary>How do I use this?</summary>
              <p>
                Put <strong>one exact phrase per line</strong> — each line is a single thing to redact
                everywhere it appears. Use the whole phrase (<code>Northwind Trading</code>), not its parts.
                Optionally add <code>| TYPE</code> so the decoy fits its kind:
                <code>PERSON</code>, <code>ORG</code>, <code>CASE_NAME</code>, <code>CASE_NUMBER</code>.
              </p>
              <p className="ex">
                Jane Doe | PERSON<br />
                Northwind Trading | ORG<br />
                Smith v. Jones | CASE_NAME
              </p>
            </details>
            <textarea id="terms" value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} />
          </section>
          <section className="card">
            <label className="eyebrow" htmlFor="wl">Never touch (whitelist)</label>
            <textarea id="wl" value={whitelist} onChange={(e) => setWhitelist(e.target.value)} rows={3} />
          </section>
          <section className={`card ticket${mapping.length ? '' : ' muted'}`}>
            <div className="ticket-head">
              <span className="eyebrow">Claim ticket</span>
              <span className="brasstag">{mapping.length}</span>
            </div>
            <p className="hint">
              {mapping.length
                ? 'The mapping never leaves this browser. Export it encrypted to restore later.'
                : 'No ticket yet — sanitize something to create one, or import an existing .cloak to restore.'}
            </p>
            <div className="ticket-actions">
              <button className="ghost" onClick={exportBridge} disabled={!mapping.length}>Export .cloak</button>
              <label className="ghost file">
                Import
                <input type="file" accept=".cloak,application/json" hidden
                  onChange={(e) => e.target.files?.[0] && importBridge(e.target.files[0])} />
              </label>
            </div>
          </section>
        </aside>

        <section className="stage">
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
                  <Pane label="Original" sub="paste your raw text/logs">
                    <textarea value={original} onChange={(e) => setOriginal(e.target.value)} spellCheck={false} />
                  </Pane>
                  <div className="arrow" aria-hidden>→</div>
                  <Pane label="Sanitized" sub="safe to paste into any LLM"
                    action={result?.sanitized && <button className="ghost" onClick={() => copy(result.sanitized, 'sanitized')}>Copy</button>}>
                    <pre className="readout">{result?.sanitized || <span className="placeholder">Run sanitize to see decoyed output…</span>}</pre>
                  </Pane>
                </div>
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
                {result.audit.map((a) => (
                  <li key={a.placeholder}>
                    <span className="tag">{a.type}</span>
                    <span className="mask">{a.preview}</span>
                    <span className="to">→</span>
                    <code>{a.placeholder}</code>
                    {a.count > 1 && <span className="count">×{a.count}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>

      {flash && <div className="flash" role="status">{flash}</div>}
    </div>
  );
}

function Pane({ label, sub, action, children }: {
  label: string; sub: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <div className="pane-label">{label}</div>
          <div className="pane-sub">{sub}</div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
