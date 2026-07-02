# Cloakroom — Threat Model & Privacy Analysis

**Security goal:** the server (and any network observer) never obtains the user's real sensitive data or the original↔placeholder mapping in plaintext. The tool must be trustworthy to a paranoid security engineer who assumes the host is hostile.

## Trust boundaries

| Component | Sees plaintext? | Sees mapping? | Notes |
|---|---|---|---|
| Browser tab (JS) | yes | yes | Trusted compute. Everything sensitive happens client-side. |
| Web Worker | yes | yes | Same origin; isolates CPU-heavy detection from the UI thread. |
| localStorage | yes (if user opts in) | yes | Plaintext at rest unless encrypted; off by default for mapping. |
| `cloak` CLI process | yes | yes | Same trust position as the browser tab: local, zero runtime deps, no network. Passphrase via `$CLOAK_PASS` or hidden TTY prompt — never argv. |
| `cloak wrap` child command | sees *sanitized* stdin+args | no | The wrapped LLM CLI gets decoys; mapping lives only in the wrap process's memory (ephemeral by default). |
| Claude Code hooks | yes (they do the redaction) | yes | Run locally per tool call. Guard never persists anything; sanitize/restore keep the mapping in the session bridge. Fail CLOSED when misconfigured (withhold output / deny the write). |
| `.cloak` bridge file | no | encrypted | AES-256-GCM, PBKDF2-SHA256 600k. |
| `<bridge>.key` session keyfile | no | **decrypts the session bridge** | Hook-mode only (never interactive CLI). Mode 0600, git-ignored. Anyone who can read it can decrypt the *session* bridge — near-zero marginal risk vs. `$CLOAK_PASS` already in the same user's process env, but delete it when the session ends. Exported/shared bridges stay passphrase-only. |
| Term pack files | no plaintext *data* — but the term list itself is sensitive | no | A pack enumerates the names you protect. Treat as an internal document; never commit a real one publicly. Configured-but-unreadable packs are a hard error (CLI) and fail closed (hooks). |
| Static host / CDN | **no** | **no** | Serves assets only. Assumed hostile. |
| Optional Worker | **no** | **no** | Aggregate opt-in counts only. |
| The LLM you paste into | sees *sanitized* text | no | Gets decoys, never originals. |

## Primary threats & mitigations

1. **Malicious/compromised server swaps in exfiltrating JS.** This is the hardest threat for any "client-side" web tool. Mitigations: ship as a self-hostable static bundle; publish a **Subresource Integrity** manifest and reproducible builds; offer the **PWA/offline** mode and **browser extension** (extensions are reviewed and version-pinned, dramatically shrinking this surface); strict CSP with `connect-src 'none'` (or `'self'` only) so injected code can't phone home. Document that maximum assurance = self-host or extension.
2. **Mapping leakage at rest.** Mapping is in-memory by default; persistence is opt-in and the exportable bridge file is always encrypted. Offer "panic clear" and auto-expiry of localStorage sessions.
3. **Wrong/partial sanitization (false negatives).** A missed secret is the worst failure. Mitigations: conservative high-recall detectors, an always-visible **audit panel** showing exactly what was replaced (masked), a manual select-to-redact tool, and a pre-copy "looks-unsanitized?" scan that warns on residual high-entropy strings.
4. **Reversal ambiguity / cascade substitution.** Solved structurally by single-pass longest-first alternation reversal (see `engine.ts`), unique-decoy enforcement, and consistent per-value mapping.
5. **Decoy mistaken for real data downstream.** Reserved/test ranges (RFC 5737/2606, area-900 SSN, test BIN) make decoys identifiable as non-real, reducing the chance someone acts on a fake IP/card.
6. **Context loss in AI responses.** The model may paraphrase, translate, or drop a placeholder so reversal can't re-anchor it. `reverseGaps()` flags placeholders absent from the response; UI warns the user which items couldn't be restored. `token` mode reduces (not eliminates) this; realistic mode keeps decoys "echoable."
7. **Side channels.** No analytics by default; no third-party scripts; clipboard and file reads stay local. Telemetry, if ever added, is opt-in aggregate counts with no content.

## Agent-boundary threats (CLI / Claude Code surfaces)

8. **A model-invoked tool is always too late.** Any sanitizer the agent *calls* (MCP tool, Bash command) runs after the agent already has the text in context. Enforcement must sit at the tool boundary — the Claude Code hooks (`PostToolUse` output rewrite, `PreToolUse` input rewrite/deny) — not in a tool the model chooses to use. This is why the deliberately-skipped MCP server would omit `restore` entirely.
9. **Misconfiguration must not fail open.** If the transparent profile is installed but its env is missing, or a configured term pack is unreadable, the hooks withhold output / deny the call rather than silently pass raw secrets. A silent no-op sanitizer is worse than a loud broken one.
10. **Decoy re-detection.** Scanners would flag Cloakroom's own reserved-range decoys as secrets (a decoy IP *is* an IP). `isLikelyDecoy()` recognizes the reserved ranges so already-sanitized text doesn't re-trip guards — and because those ranges are reserved, a real value can never be misclassified as a decoy.

## Honest limitations

- A determined hostile host serving JS can defeat any pure-web client-side tool on the *first* load; that's physics, not a bug. Self-host / extension / offline PWA are the real-assurance paths and must be promoted as such.
- Free-text **names/orgs** detection is inherently imperfect; user-declared terms and opt-in NER are the reliable levers, and the audit panel keeps the human in the loop.
- This tool reduces leakage; it is **not** a guarantee that sanitized text is safe to share. Say so plainly in the UI.

## Edge cases handled / to handle

- **Repeated values** → one consistent decoy (done).
- **Overlapping matches** (e.g. an email inside a URL) → confidence-ranked greedy resolution (done).
- **Nested structures** (JSON/YAML/CSV) → MVP treats as text; Phase 3 adds structure-aware passes so keys aren't mangled and only values are swapped.
- **Very large inputs** → run detection in a Web Worker, chunk by lines with overlap windows, stream results; cap localStorage and prompt for bridge-file export instead.
- **Ambiguous low-confidence hits** (generic phone/hash) → surfaced as *suggestions* in the audit panel rather than auto-applied above the confidence floor.
