// Generate the README's animated terminal demos as CSS-animated SVGs:
//   docs/cli-demo.svg   — the `cloak wrap` round trip
//   docs/scan-demo.svg  — the `cloak scan` pre-commit gate
//
// Why generated SVG instead of a recorded GIF: crisp text at any zoom, ~2% of
// a GIF's size, dark-theme native, deterministic (no font/terminal jank), zero
// recording tooling, and it re-renders from the scene data below whenever the
// CLI's story changes. GitHub renders CSS-animated SVGs in READMEs via <img>.
//
// Technique notes (the parts that are easy to get wrong):
// - Loop choreography: every element animates for the SAME full cycle with its
//   delay baked into keyframe PERCENTAGES. animation-delay only applies to the
//   first iteration and would desynchronize every later loop.
// - Crossfades are whole-line (two stacked <text> variants, opacity-swapped)
//   so nothing depends on exact glyph metrics of the viewer's monospace font.
// - Typing uses a clipPath width animation with steps(N) for terminal cadence.
// - prefers-reduced-motion: all animation off, final frame shown static — the
//   scene must be authored so its last frame reads as a complete story.
//
// Usage: node scripts/gen-cli-demo.mjs

import { writeFileSync } from 'node:fs';

// ---------- design tokens ----------------------------------------------------
const T = {
  ink: '#10141C', // window
  edge: '#2A3242', // border / chrome
  bar: '#161B26', // title bar
  text: '#C9D2E0', // default output
  faint: '#68748A', // prompts, labels, chrome text
  amber: '#E8B04B', // REAL secret
  cyan: '#4FD6C4', // reserved-range DECOY / safe
  red: '#E0685E', // blocked / gate failure
  font: `'JetBrains Mono','Fira Code','SF Mono',ui-monospace,Menlo,Consolas,'DejaVu Sans Mono',monospace`,
};

const W = 780;
const PAD = 26;
const FS = 12.5;
const LH = 21;
const HOLD_END = 0.92; // fraction of the cycle where the loop's fade-out begins

// ---------- scenes -----------------------------------------------------------
// span = plain string (default color) or [text, 'amber'|'cyan'|'red'|'faint'|'text']
// kinds: type (caret typing), show (fade/rise in), swap (variant a → b crossfade at `at`)
const S = (t, kind, spans, extra = {}) => ({ t, kind, spans, ...extra });

const wrapScene = {
  out: 'docs/cli-demo.svg',
  title: 'cloak wrap — check your secrets at the door',
  aria: 'Terminal demo: cloak wrap sanitizes an incident log into reserved-range decoys for the LLM, then restores the real values in its reply.',
  cycle: 19,
  events: [
    S(0.4, 'type', [['$ ', 'faint'], 'cat incident.log'], { dur: 1.0 }),
    S(1.7, 'show', [
      ['[ERROR] ', 'faint'], 'auth failed for ', ['sarah.kim@acmelegal.com', 'amber'],
      ' from ', ['10.20.30.40', 'amber'],
    ]),
    S(1.95, 'show', [
      '        card ', ['4111 1111 1111 1111', 'amber'], ' flagged; retry from ',
      ['10.20.30.40', 'amber'],
    ]),
    S(3.1, 'type', [['$ ', 'faint'], 'cat incident.log | ', ['cloak wrap', 'text'], ' -- claude -p ', ['"diagnose this"', 'faint']], { dur: 1.7 }),
    S(5.3, 'show', [['        cloak · 3 values decoyed for the trip', 'faint']]),
    S(6.0, 'swap', null, {
      a: [
        ['  → claude sees  ', 'faint'], 'auth failed for ', ['sarah.kim@acmelegal.com', 'amber'],
        ' from ', ['10.20.30.40', 'amber'],
      ],
      b: [
        ['  → claude sees  ', 'faint'], 'auth failed for ', ['casey.rivera@example.net', 'cyan'],
        ' from ', ['203.0.113.181', 'cyan'],
      ],
      at: 7.4,
    }),
    S(6.25, 'swap', null, {
      a: [
        '                 card ', ['4111 1111 1111 1111', 'amber'], ' flagged; retry from ',
        ['10.20.30.40', 'amber'],
      ],
      b: [
        '                 card ', ['4716 9053 2881 4402', 'cyan'], ' flagged; retry from ',
        ['203.0.113.181', 'cyan'],
      ],
      at: 7.4,
    }),
    S(9.2, 'swap', null, {
      a: [
        ['  ← you get back ', 'faint'], 'The repeated retries from ', ['203.0.113.181', 'cyan'],
        ' point at a gateway fault;',
      ],
      b: [
        ['  ← you get back ', 'faint'], 'The repeated retries from ', ['10.20.30.40', 'amber'],
        ' point at a gateway fault;',
      ],
      at: 10.8,
    }),
    S(9.45, 'swap', null, {
      a: ['                 reset the session for ', ['casey.rivera@example.net', 'cyan'], ' and retry.'],
      b: ['                 reset the session for ', ['sarah.kim@acmelegal.com', 'amber'], ' and retry.'],
      at: 10.8,
    }),
    S(12.4, 'show', [['✓ ', 'cyan'], ['real data never left this machine', 'text']], { gap: 1 }),
  ],
};

const scanScene = {
  out: 'docs/scan-demo.svg',
  title: 'cloak scan — the pre-commit gate',
  aria: 'Terminal demo: a git commit carrying PII fails the cloak-scan pre-commit gate with a masked audit; after scrubbing the file, the same commit passes.',
  cycle: 17,
  events: [
    S(0.4, 'type', [['$ ', 'faint'], 'git commit -m ', ['"add incident notes"', 'faint']], { dur: 1.3 }),
    S(2.2, 'show', ['cloak scan (PII/secret gate)', ['.................................', 'faint'], ['Failed', 'red']]),
    S(2.5, 'show', [['- exit code: 3', 'faint']]),
    S(3.3, 'show', [['notes/incident.md — ', 'faint'], 'detected 3 distinct value(s):']),
    S(3.7, 'show', [
      '  EMAIL      1×  ', ['sa████████om', 'amber'], ['   masked — originals are never printed', 'faint'],
    ]),
    S(3.95, 'show', ['  IPV4       2×  ', ['10████.40', 'amber']]),
    S(4.2, 'show', ['  SSN        1×  ', ['52███████34', 'amber']]),
    S(5.4, 'show', [['✗ ', 'red'], 'commit blocked — nothing sensitive reached git history'], { gap: 1 }),
    S(7.6, 'type', [['$ ', 'faint'], 'cloak sanitize notes/incident.md --bridge notes.cloak', ['  # scrub, keep the key', 'faint']], { dur: 1.6, gap: 1 }),
    S(9.9, 'type', [['$ ', 'faint'], 'git commit -m ', ['"add incident notes"', 'faint']], { dur: 1.3 }),
    S(11.7, 'show', ['cloak scan (PII/secret gate)', ['.................................', 'faint'], ['Passed', 'cyan']]),
    S(12.3, 'show', [['[main 3f2a1c9] ', 'faint'], 'add incident notes']),
    S(13.3, 'show', [['✓ ', 'cyan'], ['the gate holds — secrets stay out of history'], ], { gap: 1 }),
  ],
};

// ---------- renderer ----------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const spanText = (sp) => (typeof sp === 'string' ? sp : sp[0]);
const plain = (spans) => spans.map(spanText).join('');
const spansToTspans = (spans) =>
  spans
    .map((sp) => {
      const [text, cls] = typeof sp === 'string' ? [sp, 'text'] : sp;
      return `<tspan class="c-${cls}">${esc(text)}</tspan>`;
    })
    .join('');

function renderScene({ out, title, aria, cycle, events }) {
  const pct = (sec) => ((sec / cycle) * 100).toFixed(2);
  const outStart = pct(cycle * HOLD_END);
  const outEnd = pct(cycle * HOLD_END + 0.6);
  const CHW = FS * 0.602; // monospace advance estimate (only for the type-reveal width)

  let css = '';
  let body = '';
  let y = 0;
  let n = 0;

  for (const ev of events) {
    y += LH * (1 + (ev.gap ?? 0));
    n += 1;
    const id = `e${n}`;

    if (ev.kind === 'type') {
      const text = plain(ev.spans);
      const width = Math.ceil(text.length * CHW) + 2;
      const a = pct(ev.t);
      const b = pct(ev.t + ev.dur);
      css += `@keyframes k${n}{0%,${a}%{width:0;opacity:1}${b}%,${outStart}%{width:${width}px;opacity:1}${outEnd}%,100%{width:${width}px;opacity:0}}`;
      css += `.${id} rect{animation:k${n} ${cycle}s steps(${text.length}) infinite}`;
      body += `<g class="${id}"><clipPath id="clip${n}"><rect x="${PAD}" y="${y - FS}" height="${LH}" width="0"/></clipPath>` +
        `<text x="${PAD}" y="${y}" clip-path="url(#clip${n})">${spansToTspans(ev.spans)}</text></g>`;
    } else if (ev.kind === 'show') {
      const a = pct(ev.t);
      const b = pct(ev.t + 0.35);
      css += `@keyframes k${n}{0%,${a}%{opacity:0;transform:translateY(3px)}${b}%,${outStart}%{opacity:1;transform:none}${outEnd}%,100%{opacity:0;transform:none}}`;
      css += `.${id}{opacity:0;animation:k${n} ${cycle}s ease-out infinite}`;
      body += `<text class="${id}" x="${PAD}" y="${y}">${spansToTspans(ev.spans)}</text>`;
    } else if (ev.kind === 'swap') {
      const a = pct(ev.t);
      const b = pct(ev.t + 0.35);
      const c = pct(ev.at);
      const d = pct(ev.at + 0.7);
      css += `@keyframes k${n}a{0%,${a}%{opacity:0}${b}%,${c}%{opacity:1}${d}%,100%{opacity:0}}`;
      css += `@keyframes k${n}b{0%,${c}%{opacity:0}${d}%,${outStart}%{opacity:1}${outEnd}%,100%{opacity:0}}`;
      css += `.${id}a{opacity:0;animation:k${n}a ${cycle}s ease-out infinite}` +
        `.${id}b{opacity:0;animation:k${n}b ${cycle}s ease-out infinite}`;
      body += `<text class="${id}a" x="${PAD}" y="${y}">${spansToTspans(ev.a)}</text>` +
        `<text class="${id}b" x="${PAD}" y="${y}">${spansToTspans(ev.b)}</text>`;
    }
  }

  const BAR = 34;
  const H = y + LH + 18 + BAR;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">
<style>
text{font-family:${T.font};font-size:${FS}px;fill:${T.text};white-space:pre}
.c-text{fill:${T.text}}.c-faint{fill:${T.faint}}.c-amber{fill:${T.amber}}.c-cyan{fill:${T.cyan}}.c-red{fill:${T.red}}
${css}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important}
  text{opacity:1!important}
  [class^="e"][class$="a"]{opacity:0!important}
  clipPath rect{width:${W}px!important}
}
</style>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="${T.ink}" stroke="${T.edge}"/>
<rect x="1" y="1" width="${W - 2}" height="${BAR}" rx="10" fill="${T.bar}"/>
<rect x="1" y="${BAR - 10}" width="${W - 2}" height="10" fill="${T.bar}"/>
<circle cx="22" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<circle cx="40" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<circle cx="58" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<text x="${W / 2}" y="${BAR / 2 + 5}" text-anchor="middle" class="c-faint" style="font-size:11px">${esc(title)}</text>
<g transform="translate(0 ${BAR + 10})">
${body}
</g>
<line x1="1" y1="${BAR}" x2="${W - 1}" y2="${BAR}" stroke="${T.edge}" stroke-width="1"/>
</svg>
`;

  writeFileSync(out, svg);
  console.log(`Wrote ${out} (${(svg.length / 1024).toFixed(1)} KB, ${cycle}s loop, ${n} elements)`);
}

renderScene(wrapScene);
renderScene(scanScene);
