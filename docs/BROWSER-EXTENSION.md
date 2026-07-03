# Browser extension — design (planned, not yet built)

> Status: **design only.** This is the plan a future session or contributor picks
> up to build the extension. Nothing here ships yet; the roadmap item is parked
> deliberately. Everything below reuses the existing `src/core` engine — the
> extension is mostly packaging and per-site glue, not new sanitization logic.

## Why an extension at all

Two reasons, and the second is the one people miss.

**UX.** The browser app already does the round trip, but it's a separate tab: you
paste in, copy decoys out, switch to ChatGPT/Claude/Grok, paste, then bring the
reply back. An extension collapses that into the site you're already on — cloak
the composer in place, restore the reply where it appears.

**Trust — this is the real prize.** The threat model's "maximum assurance" row
has always named a *pinned browser extension* as the way to remove the one
residual risk a hosted web app can't: a malicious or compromised host serving
tampered JS on your next load ("physics, not a bug, for any web app"). A
store-reviewed, version-pinned extension is code that doesn't silently change
under you between visits. So the extension isn't a nicer skin on the SPA — it's
the highest-assurance distribution channel Cloakroom has. Treat that as a
feature, not a footnote, in the store listing and the README.

## The core interaction question (the real design fork)

On an LLM site the user types into a composer (textarea or contenteditable),
sends, and a reply streams into the DOM. Cloakroom must sanitize before send and
restore in the reply. Three ways to wire that, in increasing magic and
decreasing robustness:

1. **Popup mini-app.** The toolbar popup is the current SPA in miniature: paste
   in, copy decoys out, paste the reply back, copy restored. Zero site-specific
   code; works on every site and in non-LLM contexts. Marginal value over the
   PWA, but it's the safety net that always works and the home for settings,
   the audit panel, and pack import/export.
2. **Explicit in-place (recommended MVP).** The user writes in the site's own
   composer, then triggers Cloakroom — a hotkey, a context-menu item ("Cloak
   this field"), or a small floating button. The content script reads the
   composer, replaces its text with decoys in place, and keeps the mapping in
   the extension (not the page). "Restore reply" (hotkey / context menu on the
   response) swaps decoys back to originals. Robust because it's user-triggered:
   no guessing when "send" happened, no racing a streaming response, and the
   human decides exactly when plaintext gets touched.
3. **Auto-intercept (Phase 2, per-site, opt-in).** The content script watches
   the composer and the response stream and does the swap automatically on
   send / as tokens arrive. This is the seamless dream and the fragile reality:
   every site's DOM differs, "send" can be Enter, a button, or programmatic,
   streaming responses mutate token-by-token, and a missed send path is a
   silent leak. It needs a tested DOM adapter per site, must be opt-in per site,
   and must fail *closed* (if the adapter can't confidently find the composer,
   do nothing and tell the user — never let unsanitized text through believing
   it was handled).

**Recommendation:** ship 1 + 2 as the MVP (they work everywhere with no brittle
per-site code and keep the user in control of the plaintext boundary), and treat
3 as a later, per-site, opt-in enhancement with its own adapter tests. Do not
lead with auto-intercept — the failure mode is a false sense of safety.

## Architecture (Manifest V3)

```
extension/
├── manifest.json            # MV3; minimal permissions (see below)
├── background.ts            # service worker: owns the session mapping + crypto,
│                            #   coordinates content scripts and popup
├── content/
│   ├── content.ts           # isolated-world script: read/replace composer text,
│   │                        #   locate response nodes; hotkey + context-menu hooks
│   └── sites/               # Phase 2: per-site DOM adapters (chatgpt, claude, grok)
├── popup/                   # the mini-app (paste-in/out, audit, pack import/export)
├── options/                 # term packs, whitelist, mode, persistence opt-in
└── (bundles @cloakroom/core verbatim — no re-implementation)
```

Load-bearing points for the implementer:

- **`src/core` ports verbatim.** It's already dependency-free, DOM-free, and uses
  Web Crypto — which is available in MV3 service workers and content scripts. The
  engine, `packs.ts`, `review.ts` (segmentize / decide-selection), and the
  session-crypto helpers all move over with zero changes. This is why the
  extension is small: the hard part already exists and is tested.
- **The mapping lives in the extension, never in the page.** Source of truth is
  the service worker, persisted to `chrome.storage.session` (survives an MV3
  worker restart, dies on browser close). Content scripts get decoys and send
  back selections; they never receive the mapping. Optional encrypted durable
  persistence reuses the SPA's `session.ts` design (passphrase-derived key,
  memory-only, 7-day expiry, panic clear).
- **The engine is one door more.** README's "one engine, four doors" becomes
  five; the extension consuming the same `src/core` is the whole point.

## Threat-model deltas (update `docs/THREAT-MODEL.md` when built)

- **Removes the first-load-tampering risk** (the maximum-assurance win above):
  store-reviewed, version-pinned code. New row/mitigation.
- **Content scripts run in the page's tab but an isolated world** — the page's
  own JS cannot read the extension's variables or the mapping. Still, reading the
  composer means the extension touches the page's plaintext (that's the job);
  document that the mapping never enters the page DOM.
- **Least privilege permissions.** `activeTab` + explicit `host_permissions` for
  the specific LLM origins only — never `<all_urls>`, never broad `tabs`. MV3
  forbids remote code; the extension makes **zero network requests** (no host
  permissions for fetch), preserving the "nothing is sent" posture the CSP gives
  the web app.
- **Persistence defaults to memory-only** (`storage.session`); durable storage is
  the same opt-in, encrypted, expiring design as the web app.

## Cross-browser & distribution

- **Chrome + Edge**: MV3 directly. **Firefox**: MV3 with `browser.*` differences —
  use `webextension-polyfill`. **Safari**: separate Xcode packaging path; defer.
- **Stores**: Chrome Web Store + Firefox AMO, each with their own review + signing.
- **Provenance chain, extended.** Build the extension `.zip` in CI and attest it
  (like the npm tarball and the Pages bundle); link the store listing to the exact
  commit; AMO supports source-code submission for reproducibility. Goal: the
  "attested at every door" story now covers the extension too — `git clone` →
  auditable source, `npm install` → attested binary, live demo → attested deploy,
  extension → attested + store-reviewed build.

## Suggested phasing

- **Phase 1 (MVP):** popup mini-app + explicit in-place cloak/restore
  (hotkey + context menu), Chrome/Edge + Firefox, memory-only mapping, term-pack
  and whitelist reuse from `src/core`, options page. No per-site DOM adapters.
- **Phase 2:** opt-in auto-intercept with tested per-site adapters
  (chatgpt.com, claude.ai, grok), each fail-closed; streaming-response restore.
- **Phase 3:** encrypted durable persistence, Safari packaging, per-site enable
  toggles surfaced in the popup.

## Open decisions (for whoever picks this up)

- Monorepo layout: add `extension/` to this repo (shared `src/core` via a
  workspace) vs. a sibling repo. Leaning **same repo, workspace** — keeps the
  engine as one source of truth and the attestation story in one place.
- Build tooling: `@crxjs/vite-plugin` (fast, MV3-aware, but a moving target) vs.
  a hand-rolled MV3 build reusing the existing esbuild setup. Leaning hand-rolled
  for the same zero-dependency, auditable reasons the CLI is hand-rolled.
- MVP trigger ergonomics: hotkey vs. context menu vs. floating button — pick one
  primary, likely context menu (discoverable, no keybinding conflicts).
- Whether Phase 1 ships auto-intercept for *just* one site (claude.ai, dogfood
  target) behind an explicit opt-in, or holds all auto-intercept to Phase 2.

## Rough effort

Phase 1 is small precisely because `src/core` is done: MV3 manifest + service
worker + popup (largely the SPA's non-React logic) + a minimal content script for
in-place replace + options page. The genuinely new surface area is MV3 plumbing
(service-worker lifecycle, `storage.session` rehydration, message passing) and
the CI attest-the-zip step — not sanitization. Phase 2's per-site adapters are
where the real, ongoing maintenance cost lives; scope them one site at a time.
