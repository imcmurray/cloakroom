# Contributing to Cloakroom

Thanks for helping. Cloakroom is a privacy tool, so a few of these guidelines are
stricter than a typical project — they exist to keep the "nothing leaves the machine"
promise credible.

## Ground rules

- **No network calls in the client or core.** The browser app ships a CSP of
  `connect-src 'none'`; the engine, CLI, and hooks must never `fetch`, open a socket, or
  phone home. `grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon" src/` must return
  exactly one hit: the UI's egress probe (`src/ui/App.tsx`), a fetch that exists to be
  blocked by the CSP so visitors can watch the block happen. Adding a second hit needs
  an extraordinary justification and a README update in the same PR.
- **Keep the CLI dependency-free.** `src/cli` and `src/core` have zero runtime
  dependencies on purpose — every dependency is supply-chain surface for a security tool.
  Prefer a few lines of hand-rolled code over a package. Dev/build tooling (vite, esbuild,
  vitest, types) is fine.
- **The mapping is the secret.** Anything that persists the original↔placeholder mapping
  must go through the encrypted bridge (`crypto.ts`), never plaintext at rest. Never print
  full originals — mask them (`maskPreview`).
- **Detectors should favor recall.** A missed secret (false negative) is the worst
  failure; an over-eager decoy is recoverable. New detectors need a test proving they both
  detect and round-trip.

## Layout

- `src/core/` — the pure, framework-agnostic engine (detectors, generators, engine,
  crypto). Runs identically in the browser, a Web Worker, the CLI, and hooks. This is the
  one source of truth — add capability here, not in a consumer.
- `src/ui/` — the React SPA.
- `src/cli/` — the `cloak` command line: sanitize/restore/`wrap`/scan/inspect, term
  packs, the session key cache, and the `cloak hook` Claude Code adapter.
- `integrations/claude-code/` — ready-to-use hook profiles and a slash command.
- `docs/` — threat model, CLI example, Claude Code integration.

## Dev loop

```bash
npm install        # also builds the CLI (via the prepare script)
npm run typecheck  # tsc --noEmit over src (covers CLI too)
npm test           # vitest: engine, crypto, CLI args, hook round trip
npm run build:cli  # rebuild dist-cli/cloak.mjs after CLI changes
npm run dev        # the SPA
```

Every change needs `npm run typecheck` and `npm test` green. Behavior changes to
detection, replacement, reversal, or the hook contract need a test. CI runs the build,
the tests, and a CLI smoke test on every PR.

## Threat-model changes

If a change affects what a hostile host / network / process can see, update
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) in the same PR and call it out in the
description.
