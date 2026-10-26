# Changelog

All notable changes to Cloakroom are noted here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project is pre-1.0, so minor
versions may include breaking changes.

## [Unreleased]

## [0.4.2] — 2026-10-26

### Security
Follow-up hardening for GHSA-4334-p9gq-hpqf.

- **Hooks enforce their own time limit.** Claude Code lets a tool call through
  when a hook exceeds its `timeout` (the Read happens, the raw output reaches
  the model), so a slow enough hook failed open. `cloak hook` now runs its work
  in a worker thread under `--deadline <seconds>` (default 20) and fails closed
  (withhold / deny) when the deadline passes. The shipped profiles set
  `"timeout": 30`. Costs ~30 ms per hook call.
- **Bridge and key files are written atomically** (temp file + rename), so a
  hook stopped mid-write can't corrupt the session bridge, and an existing file
  is re-created 0600 instead of keeping looser permissions.

## [0.4.1] — 2026-10-26

### Security
Advisory: GHSA-gx33-3r5r-jxqh. Upgrade if your transparent profile restores into
`Bash`.

- **Restoring real values into shell commands now needs your approval.** With
  `|Bash` added to the transparent profile's restore matcher, the hook silently
  swapped decoys back to real values in any command, including one that sends
  them off the machine (a prompt-injected `curl …?k=<decoy>`). A restored
  command now returns `permissionDecision: "ask"`, which also holds under
  bypass permissions; headless `-p` runs block it. Calls with no decoys are no
  longer touched at all.
- **The guard no longer fails open.** Internal errors used to allow the read
  or pass the output through; they now deny / withhold. A malformed hook event,
  or any error escaping a hook mode, exits 2 (Claude Code's blocking error)
  instead of 0/1, which let the call proceed.
- **MCP tools are covered.** Both hook profiles now match `mcp__.*`, so
  database/CRM MCP results are withheld (guard) or decoyed (transparent).

## [0.4.0] — 2026-10-26

### Added
- **Term packs in the browser app** — the web UI is now the pack editor: "Import
  pack" merges a pack JSON into your vocabulary (exact-duplicate entries skipped,
  malformed packs rejected loudly with the reason — never partially applied);
  "Export pack" downloads your terms + whitelist as the same JSON every other
  surface consumes (CLI `--pack`, hooks `$CLOAK_PACKS`). Pack parsing/validation
  moved to core (`parseTermPack`/`serializeTermPack`/`mergePack`) so browser and
  CLI semantics can never drift; the CLI is stricter now — a malformed entry
  fails the pack instead of being silently skipped.

### Security
Advisories: GHSA-4334-p9gq-hpqf, GHSA-rm2r-4mgq-c7wm. Upgrade if you use the Claude
Code hooks, `cloak wrap`, or `cloak scan` as a gate.

- **Sanitizing could hang on ordinary input, and a hung hook lets output
  through.** Several realistic-decoy pools are small (18 hostnames, 10 orgs,
  144 people, 762 RFC 5737 IPs), and the uniqueness loop re-rolled forever once
  one ran dry: 19 distinct hostnames were enough. Re-rolls are now capped, after
  which decoys widen with a per-type counter (`acme-3.example.com`, or a
  `«IPV4_n»` token where a counter can't stay a valid reserved value). Overlap
  resolution and output assembly were also quadratic (a 20k-line log took
  ~32 s) and are now linear (~1 s).
- **Common secret formats were not detected.** Added detectors for Anthropic /
  OpenAI (`sk-ant-`, `sk-proj-`), Stripe (`sk_live_`), GitHub fine-grained
  (`github_pat_`), GitLab (`glpat-`), npm (`npm_`) and Google (`AIza`) keys, PEM
  private key blocks (new `PRIVATE_KEY` type), `password=` / `"client_secret":`
  / `aws_secret_access_key =` style assignments, and passwords in connection
  strings (new `SECRET` type; only the value is replaced, the key name stays).

### Fixed
- **Whitelisting now protects the whole span.** Whitelisted matches previously
  vanished before overlap resolution, handing their territory to lower-confidence
  overlapping detectors (the boundary-less PHONE pattern could decoy digits out of
  a whitelisted UUID). Whitelisted values now win their span and are simply never
  replaced. Found by the term-pack E2E.

## [0.3.0] — 2026-07-02

### Added
- **Published to npm as [`@imcmurray/cloakroom`](https://www.npmjs.com/package/@imcmurray/cloakroom)**
  (`npm install -g @imcmurray/cloakroom` → the `cloak` command). Every release is
  published from CI with **SLSA provenance** (`npm publish --provenance`) — verify
  installed versions with `npm audit signatures`. The tarball ships the built CLI,
  the Claude Code hook profiles, the example term pack, and the key docs.
- **Encrypted session-restore (opt-in).** "Save session" keeps your tabs across
  reloads: snapshots are AES-256-GCM encrypted under a passphrase (PBKDF2 600k,
  same envelope as bridge files) before touching localStorage; the key lives only
  in memory so every reload asks again; plaintext metadata is limited to saved-at
  and tab count; sessions auto-expire after 7 days; "Forget & turn off" is a
  one-click panic clear. Wrong passphrases leave the stored session untouched.
  Core gains generic `encryptJson`/`decryptJson` (+`WithKey` variants); bridge
  functions are now thin wrappers over the same envelope.
- **Document tabs in the browser app.** Work on several documents at once: each
  tab is an independent workspace (original, sanitized result, mapping, AI reply,
  restored output) that survives switching untouched; your sensitive terms,
  whitelist, and mode are shared across tabs. Tabs are labeled from their content
  and wear their claim-ticket count; closing a tab with a mapping asks first, and
  the sidebar ticket (export) always reflects the active tab. Importing a
  `.cloak` bridge now always opens its own tab, so it can never clobber a
  document in progress.
- **Review-and-refine in the browser app.** The Sanitized pane now paints every
  decoy in its type color (untinted text = untouched, so leftovers stand out);
  selecting missed text in either Outbound pane raises an action bar to cloak it
  everywhere (with a type picker, so the decoy stays shape-matched); clicking a
  decoy — or the new per-row audit button — un-cloaks a false positive by
  whitelisting the original. Every change re-runs the engine, so the mapping,
  audit, and occurrence-consistency are never bypassed; sanitized text is
  deliberately NOT directly editable (a hand edit would have no mapping entry
  and could not be restored).

## [0.2.0] — 2026-07-02

### Added
- **`cloak wrap -- <command>`** — run any command inside the cloak: stdin and the
  child's arguments are sanitized on the way in, its stdout is restored (line-buffered,
  streaming-friendly) on the way out. Sanitize+restore share one process, so the
  default needs no bridge file and no passphrase; `--bridge`/`--merge` optionally
  persist the mapping. Child stderr passes through; exit code propagates.
- **Term packs** — shareable JSON dictionaries of org-specific custom terms and
  whitelist entries, loaded via `--pack a.json,b.json` or `$CLOAK_PACKS` (colon-
  separated) across the CLI, `wrap`, and the Claude Code hooks. Unreadable configured
  packs are a hard error (CLI) or fail closed (hooks) — terms are never silently
  skipped. Example: `integrations/packs/example-courthouse.json` (fictional names; a
  real pack is itself sensitive — keep it private).
- **pre-commit hook** — `.pre-commit-hooks.yaml` exposes `cloak-scan` for the
  pre-commit framework; `scan` now accepts multiple files and reports per-file.
- Source-hygiene test: no control bytes (the twice-bitten NUL-separator bug class) may
  appear anywhere under `src/`.

### Added (earlier this cycle)
- **`cloak` CLI** — `sanitize`, `restore`, `scan`, and `inspect` over the core engine.
  Zero runtime dependencies; the mapping is only ever persisted as an AES-256-GCM
  encrypted `.cloak` bridge; passphrase via `$CLOAK_PASS` or a hidden TTY prompt.
- **`sanitize --merge`** — accumulate into an existing bridge so a value maps to the same
  decoy across calls (session use), backed by a new `SanitizeOptions.priorMapping`.
- **Claude Code integration** — `cloak hook <guard|sanitize|restore>` speaks the Claude
  Code hook stdin/stdout JSON contract, plus ready-to-use `guard` and `transparent`
  settings profiles and a `/cloak-sanitize` slash command in `integrations/claude-code/`.
- Docs: `docs/CLI-EXAMPLE.md` (worked round trip) and `docs/CLAUDE-CODE.md` (integration
  rationale + trade-offs); `CONTRIBUTING.md`.
- CI now builds the CLI and runs a smoke test; `npm install` builds the CLI via a
  `prepare` script.

### Changed
- **Hook latency ~24× lower**: hooks now derive the bridge key once per session and
  cache the raw derived key in `<bridge>.key` (0600, git-ignored) instead of paying
  PBKDF2-600k twice on every tool call (~1.5s → ~50ms warm). Bridges stay
  passphrase-compatible; interactive CLI commands never create keyfiles.
- **Guard covers shell output**: `cloak hook guard` now also handles PostToolUse —
  Bash/Grep output carrying secrets is withheld with a guidance notice, closing the
  `cat secrets.txt` bypass of the Read guard. Cloakroom's own reserved-range decoys
  are recognized (`isLikelyDecoy`) so sanitized text doesn't re-trip it.
- CI runs on Node 24; `engines.node >= 20` declared.

### Fixed
- **Hook contract**: `cloak hook sanitize` now reads the PostToolUse payload from
  `tool_response` (the field Claude Code actually sends — verified against the binary;
  the previously-used `tool_result` is kept as a fallback) and preserves the tool
  response's object shape, since Claude Code validates `updatedToolOutput` against the
  tool's output schema. Before this fix, transparent mode was a silent no-op.
- **Fail-closed hardening**: `hook sanitize` and `hook restore` now fail closed when
  `$CLOAK_SESSION_BRIDGE` / `$CLOAK_PASS` are missing (withhold output / deny the tool
  call) instead of silently passing raw secrets or decoys through. `hook restore` also
  covers Bash `command` inputs.
- `cloak sanitize` refuses to overwrite an existing bridge without `--merge` or the new
  `--force` — clobbering a bridge silently destroyed the only key that could restore
  earlier text.
- Credit-card detector no longer swallows a trailing space/hyphen into the match, so the
  decoy stops mashing into the following word.
- Replaced a stray NUL-byte separator in the engine's consistency-cache key (which made
  cross-call decoy consistency silently break, and flagged `engine.ts` as binary to git)
  with a single shared `mapKey()` helper.

## [0.1.0]
- Initial release: client-side sanitize/restore engine, React SPA, encrypted bridge
  files, PWA/offline mode, CSP `connect-src 'none'`, and build-provenance attestation.
