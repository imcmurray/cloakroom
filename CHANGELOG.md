# Changelog

All notable changes to Cloakroom are noted here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project is pre-1.0, so minor
versions may include breaking changes.

## [Unreleased]

### Added
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
