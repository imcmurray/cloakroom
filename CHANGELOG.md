# Changelog

All notable changes to Cloakroom are noted here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project is pre-1.0, so minor
versions may include breaking changes.

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
