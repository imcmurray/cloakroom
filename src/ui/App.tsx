// The app shell: shared vocabulary (terms / whitelist / mode), the tab strip,
// and one mounted Workspace per document. Inactive workspaces are hidden, not
// unmounted — every pane, mapping, and half-typed reply survives switching.
// Documents are independent: each has its own mapping (like separate bridge
// files); the vocabulary is yours and applies to whichever tab you sanitize.

import { useEffect, useRef, useState } from 'react';
import { encryptBridge, decryptBridge } from '../core/crypto';
import { mergePack, parseTermPack, serializeTermPack } from '../core/packs';
import { Workspace, parseTerms } from './Workspace';
import type { CustomTerm, MappingEntry } from '../core/types';
import {
  forgetSession, isWorthSaving, newSessionKey, peekSession, saveSession, unlockSession,
  SESSION_TTL_DAYS, type DocSnapshot, type PeekResult, type SessionKeyPair, type SessionPayload,
} from './session';

const SAMPLE = `[2026-06-30 14:22:01] ERROR ecf: filing failed for jane.doe@example-corp.com
  client 192.168.1.100 (seen again at 192.168.1.100), gateway 10.20.30.40
  token=sk-live_AB12cd34EF56gh78IJ90kl12  aws=AKIAIOSFODNN7EXAMPLE
  user "Jane Doe" employer "Northwind Trading" ssn 521-22-1234
  matter "Smith v. Jones" case 2:23-cv-00456-DBB; bankruptcy In re Doe 23-12345
  card 4111 1111 1111 1111  trace 550e8400-e29b-41d4-a716-446655440000`;

interface Doc {
  id: number;
  seedText?: string;
  seedBridge?: MappingEntry[];
  seedSnapshot?: DocSnapshot;
}
interface DocMeta {
  label: string;
  mapping: MappingEntry[];
  snapshot: DocSnapshot;
}

export function App() {
  const [mode, setMode] = useState<'realistic' | 'token'>('realistic');
  const [terms, setTerms] = useState('Jane Doe | PERSON\nNorthwind Trading | ORG');
  const [whitelist, setWhitelist] = useState('127.0.0.1');

  const nextId = useRef(2);
  const [docs, setDocs] = useState<Doc[]>([{ id: 1, seedText: SAMPLE }]);
  const [activeId, setActiveId] = useState(1);
  const [meta, setMeta] = useState<Record<number, DocMeta>>({});

  const [egress, setEgress] = useState<'idle' | 'testing' | 'blocked' | 'allowed'>('idle');
  const [flash, setFlash] = useState<string | null>(null);

  // Encrypted session-restore (opt-in): key lives ONLY in memory; blob in
  // localStorage is AES-256-GCM; peek deletes expired sessions on sight.
  const [sessionKp, setSessionKp] = useState<SessionKeyPair | null>(null);
  const [stored, setStored] = useState<PeekResult>(() => peekSession(window.localStorage));
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const activeMapping = meta[activeId]?.mapping ?? [];

  const note = (m: string) => {
    setFlash(m);
    window.setTimeout(() => setFlash(null), 2200);
  };

  function buildPayload(): SessionPayload {
    return {
      v: 1,
      mode,
      terms,
      whitelist,
      activeIndex: Math.max(0, docs.findIndex((d) => d.id === activeId)),
      docs: docs.map((d) => meta[d.id]?.snapshot).filter((s): s is DocSnapshot => Boolean(s)),
    };
  }

  // Debounced autosave whenever anything worth keeping changes.
  useEffect(() => {
    if (!sessionKp) return;
    const t = window.setTimeout(async () => {
      const payload = buildPayload();
      if (!isWorthSaving(payload)) return;
      try {
        await saveSession(window.localStorage, sessionKp, payload);
        setSavedAt(new Date().toISOString());
      } catch {
        note('Session save failed — storage full?');
      }
    }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKp, meta, terms, whitelist, mode, docs, activeId]);

  async function enableSessionSave() {
    const pass = window.prompt(
      `Create a passphrase for this browser's saved session.\nTabs + mappings are AES-256-GCM encrypted in localStorage; the passphrase is never stored. Sessions expire after ${SESSION_TTL_DAYS} days.`,
    );
    if (!pass) return;
    const kp = await newSessionKey(pass);
    setSessionKp(kp);
    await saveSession(window.localStorage, kp, buildPayload());
    setSavedAt(new Date().toISOString());
    setStored({ state: 'none' }); // any previous banner is superseded
    note('Session saving is on — encrypted, this browser only');
  }

  async function unlockStoredSession() {
    const pass = window.prompt('Passphrase to unlock your saved session:');
    if (!pass) return;
    try {
      const { payload, kp } = await unlockSession(window.localStorage, pass);
      setMode(payload.mode);
      setTerms(payload.terms);
      setWhitelist(payload.whitelist);
      const restoredDocs: Doc[] = payload.docs.map((snapshot) => ({ id: nextId.current++, seedSnapshot: snapshot }));
      setDocs(restoredDocs);
      setActiveId(restoredDocs[Math.min(payload.activeIndex, restoredDocs.length - 1)]?.id ?? restoredDocs[0].id);
      setMeta({});
      setSessionKp(kp);
      setStored({ state: 'none' });
      note(`Session restored — ${restoredDocs.length} tab${restoredDocs.length === 1 ? '' : 's'} back`);
    } catch {
      note('Wrong passphrase — session left untouched');
    }
  }

  function discardStoredSession() {
    if (!window.confirm('Delete the saved session? This cannot be undone.')) return;
    forgetSession(window.localStorage);
    setStored({ state: 'none' });
    note('Saved session deleted');
  }

  function turnOffSessionSave() {
    forgetSession(window.localStorage);
    setSessionKp(null);
    setSavedAt(null);
    note('Session saving is off — stored data deleted');
  }

  // ---- term packs: the browser is also the pack EDITOR --------------------
  // Import merges a pack into the vocabulary; select-to-cloak curates it while
  // you work; Export shares the result back to the CLI / hooks / your team.

  const termsToText = (list: CustomTerm[]): string =>
    list.map((t) => (t.type && t.type !== 'CUSTOM' ? `${t.value} | ${t.type}` : t.value)).join('\n');
  const wlLines = (raw: string): string[] => raw.split('\n').map((s) => s.trim()).filter(Boolean);

  function importPack(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pack = parseTermPack(String(reader.result));
        const merged = mergePack(parseTerms(terms), wlLines(whitelist), pack);
        setTerms(termsToText(merged.terms));
        setWhitelist(merged.whitelist.join('\n'));
        note(
          `Pack${pack.name ? ` “${pack.name}”` : ''} loaded — ${merged.added} new entr${merged.added === 1 ? 'y' : 'ies'}` +
          (merged.skipped ? `, ${merged.skipped} duplicate${merged.skipped === 1 ? '' : 's'} skipped` : '') +
          '. Re-sanitize tabs to apply.',
        );
      } catch (e) {
        // Fail loudly, never partially — same rule as the CLI and hooks.
        note(`Pack rejected: ${e instanceof Error ? e.message : 'invalid file'}`);
      }
    };
    reader.readAsText(file);
  }

  function exportPack() {
    const termList = parseTerms(terms);
    const wl = wlLines(whitelist);
    if (!termList.length && !wl.length) return note('Nothing to export — add terms or whitelist entries first');
    const name = window.prompt('Pack name (used as filename and in the file):', 'team-terms');
    if (!name) return;
    const json = serializeTermPack(name.trim(), termList, wl);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.trim().replace(/[^\w.-]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    note(`Pack exported — works with the CLI (--pack), hooks ($CLOAK_PACKS), and this page. It lists your protected names: keep it internal.`);
  }

  function addDoc(seed?: Partial<Doc>): number {
    const id = nextId.current++;
    setDocs((d) => [...d, { id, ...seed }]);
    setActiveId(id);
    return id;
  }

  function closeDoc(id: number) {
    const m = meta[id];
    if (m?.mapping.length && !window.confirm(
      `Close “${m.label}”? Its claim ticket (${m.mapping.length} mapping${m.mapping.length === 1 ? '' : 's'}) will be gone unless you exported it.`,
    )) return;
    setDocs((d) => {
      const rest = d.filter((x) => x.id !== id);
      if (id === activeId && rest.length) setActiveId(rest[Math.max(0, d.findIndex((x) => x.id === id) - 1)].id);
      return rest;
    });
    setMeta((m2) => {
      const { [id]: _gone, ...rest } = m2;
      return rest;
    });
  }

  async function runEgressTest() {
    setEgress('testing');
    try {
      await fetch('https://example.com/cloakroom-egress-probe', { mode: 'no-cors', cache: 'no-store' });
      setEgress('allowed');
    } catch {
      setEgress('blocked');
    }
  }

  async function exportBridge() {
    if (!activeMapping.length) return note('Sanitize something first');
    const pass = window.prompt('Passphrase to encrypt this bridge file (AES-256-GCM):');
    if (!pass) return;
    const blob = await encryptBridge(activeMapping, pass, mode);
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
        setMode(bf.mode);
        // A bridge always gets its own tab — never clobbers a document in progress.
        addDoc({ seedBridge: bf.mapping });
        note(`Bridge loaded in a new tab — ${bf.mapping.length} mappings ready to restore`);
      } catch {
        note('Wrong passphrase or corrupt file');
      }
    };
    reader.readAsText(file);
  }

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
              automatically; free-text proper nouns aren’t, so you list them here. Shared by every tab.
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
            <div className="ticket-actions">
              <label className="ghost file" title="Merge a shared term pack (.json) into this list — duplicates are skipped">
                Import pack
                <input type="file" accept=".json,application/json" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importPack(f); e.target.value = ''; }} />
              </label>
              <button className="ghost" onClick={exportPack}
                title="Download terms + whitelist as a pack for the CLI (--pack), hooks ($CLOAK_PACKS), or your team">
                Export pack
              </button>
            </div>
          </section>
          <section className="card">
            <label className="eyebrow" htmlFor="wl">Never touch (whitelist)</label>
            <textarea id="wl" value={whitelist} onChange={(e) => setWhitelist(e.target.value)} rows={3} />
          </section>
          <section className={`card ticket${activeMapping.length ? '' : ' muted'}`}>
            <div className="ticket-head">
              <span className="eyebrow">Claim ticket</span>
              <span className="brasstag">{activeMapping.length}</span>
            </div>
            <p className="hint">
              {activeMapping.length
                ? 'This tab’s mapping never leaves the browser. Export it encrypted to restore later.'
                : 'No ticket on this tab yet — sanitize something to create one, or import a .cloak (it opens its own tab).'}
            </p>
            <div className="ticket-actions">
              <button className="ghost" onClick={exportBridge} disabled={!activeMapping.length}>Export .cloak</button>
              <label className="ghost file">
                Import
                <input type="file" accept=".cloak,application/json" hidden
                  onChange={(e) => e.target.files?.[0] && importBridge(e.target.files[0])} />
              </label>
            </div>
          </section>
          <section className={`card session${sessionKp ? ' on' : ''}`}>
            <span className="eyebrow">Session</span>
            {sessionKp ? (
              <>
                <p className="hint">
                  Autosaving <strong>encrypted</strong> to this browser
                  {savedAt && <> · saved {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}.
                  Reloading will ask for your passphrase. Expires after {SESSION_TTL_DAYS} days.
                </p>
                <div className="ticket-actions">
                  <button className="ghost" onClick={turnOffSessionSave}>Forget &amp; turn off</button>
                </div>
              </>
            ) : (
              <>
                <p className="hint">
                  {stored.state === 'expired'
                    ? `A saved session expired (>${SESSION_TTL_DAYS} days) and was deleted. `
                    : ''}
                  Keep your tabs across reloads? Everything is AES-256-GCM encrypted with a passphrase
                  before it touches localStorage — nothing readable at rest, nothing leaves this machine.
                </p>
                <div className="ticket-actions">
                  <button className="ghost" onClick={enableSessionSave}>Save session…</button>
                </div>
              </>
            )}
          </section>
        </aside>

        <div className="deck">
          {stored.state === 'present' && !sessionKp && (
            <div className="banner" role="status">
              <span className="brasstag sm">{stored.tabCount}</span>
              <div>
                <strong>Encrypted session found</strong> — {stored.tabCount} tab{stored.tabCount === 1 ? '' : 's'}, saved{' '}
                {new Date(stored.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
                Unlock to bring them back, or discard to delete it.
              </div>
              <button className="ghost" onClick={unlockStoredSession}>Unlock…</button>
              <button className="ghost dismiss" title="Delete the saved session" onClick={discardStoredSession}>Discard</button>
            </div>
          )}
          <div className="tabs" role="tablist" aria-label="Documents">
            {docs.map((d) => {
              const m = meta[d.id];
              return (
                <span key={d.id} className={`tab${d.id === activeId ? ' on' : ''}`}>
                  <button role="tab" aria-selected={d.id === activeId} className="tab-label"
                    onClick={() => setActiveId(d.id)}>
                    {m?.label ?? 'Untitled'}
                    {(m?.mapping.length ?? 0) > 0 && <span className="brasstag sm">{m!.mapping.length}</span>}
                  </button>
                  {docs.length > 1 && (
                    <button className="tab-close" aria-label={`Close ${m?.label ?? 'tab'}`}
                      onClick={() => closeDoc(d.id)}>×</button>
                  )}
                </span>
              );
            })}
            <button className="tab-new" title="New tab — sanitize something else without losing this one"
              onClick={() => addDoc()}>+ New</button>
          </div>

          {docs.map((d) => (
            <Workspace key={d.id} active={d.id === activeId}
              mode={mode} terms={terms} whitelist={whitelist}
              setTerms={setTerms} setWhitelist={setWhitelist} note={note}
              onState={(s) => setMeta((m) => ({ ...m, [d.id]: s }))}
              seedText={d.seedText} seedBridge={d.seedBridge} seedSnapshot={d.seedSnapshot} />
          ))}
        </div>
      </main>

      <footer className="site-footer">
        <a className="gh" href="https://github.com/imcmurray/cloakroom" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden focusable="false">
            <path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          imcmurray/cloakroom
        </a>
        <span className="dot" aria-hidden>·</span>
        <span>Open source (MIT)</span>
        <span className="dot" aria-hidden>·</span>
        <span>Runs entirely in your browser — nothing you paste is ever sent anywhere.</span>

        <details className="verify">
          <summary>How do I know nothing is sent? <span className="arrow-link">verify it →</span></summary>
          <div className="verify-body">
            <p>
              This page declares <code>connect-src 'none'</code> in its Content-Security-Policy (see it
              yourself: View Source, or DevTools → Elements → the <code>&lt;meta&gt;</code> in <code>&lt;head&gt;</code>).
              The browser blocks every outbound request — prove it live:
            </p>
            <div className="verify-actions">
              <button className="ghost" onClick={runEgressTest} disabled={egress === 'testing'}>
                {egress === 'testing' ? 'Testing…' : 'Run egress test'}
              </button>
              {egress === 'blocked' && <span className="ok">✓ Blocked by your browser — this page cannot reach the network.</span>}
              {egress === 'allowed' && <span className="warn">⚠ A request went through — likely the dev build (CSP relaxed for HMR), not the deployed site.</span>}
            </div>
            <p className="hint">
              It also works fully offline (install it, then turn off Wi-Fi), and every deployed build is{' '}
              <a href="https://github.com/imcmurray/cloakroom/attestations" target="_blank" rel="noopener noreferrer">provenance-signed</a>{' '}
              — verify with <code>gh attestation verify</code>.
            </p>
          </div>
        </details>
      </footer>

      {flash && <div className="flash" role="status">{flash}</div>}
    </div>
  );
}
