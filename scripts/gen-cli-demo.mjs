// Generate docs/cli-demo.svg — an animated terminal demo of `cloak wrap`.
//
// Why a generated SVG instead of a recorded GIF: crisp text at any zoom, ~2%
// of a GIF's size, dark-theme native, deterministic (no font/terminal jank),
// zero recording tooling required, and it re-renders from this scene script
// whenever the CLI's story changes. GitHub renders CSS-animated SVGs in
// READMEs via <img>.
//
// Design notes (kept deliberate):
// - Two semantic hues tell the whole story: AMBER = your real secret,
//   CYAN = the reserved-range decoy wearing its coat-check tag. The signature
//   moment is the crossfade: amber→cyan on the way out, cyan→amber on the
//   way back. Everything else is quiet.
// - Choreography loops as one 19s cycle. Delays are baked into per-element
//   keyframe percentages (NOT animation-delay, which only applies to the
//   first iteration and would wreck every later loop).
// - prefers-reduced-motion: all animation off, final frame shown static.
//
// Usage: node scripts/gen-cli-demo.mjs   → writes docs/cli-demo.svg

import { writeFileSync } from 'node:fs';

// ---------- tokens ----------------------------------------------------------
const T = {
  ink: '#10141C', // window
  edge: '#2A3242', // border / chrome
  bar: '#161B26', // title bar
  text: '#C9D2E0', // default output
  faint: '#68748A', // prompts, labels, chrome text
  amber: '#E8B04B', // REAL secret
  cyan: '#4FD6C4', // reserved-range DECOY
  font: `'JetBrains Mono','Fira Code','SF Mono',ui-monospace,Menlo,Consolas,'DejaVu Sans Mono',monospace`,
};

const W = 780;
const PAD = 26;
const FS = 12.5; // font size
const LH = 21; // line height
const CYCLE = 19; // seconds per loop
const HOLD_END = 0.92; // fraction of cycle where fade-out begins

// ---------- scene -----------------------------------------------------------
// span = plain string (default color) or [text, 'amber'|'cyan'|'faint'|'text']
// kinds: type (caret typing), show (fade/rise in), swap (variant a → b crossfade)
const S = (t, kind, spans, extra = {}) => ({ t, kind, spans, ...extra });

const scene = [
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
    at: 7.4, // crossfade moment
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
];

// ---------- helpers ---------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (sec) => ((sec / CYCLE) * 100).toFixed(2);

function spansToTspans(spans) {
  return spans
    .map((sp) => {
      const [text, cls] = typeof sp === 'string' ? [sp, 'text'] : sp;
      return `<tspan class="c-${cls}">${esc(text)}</tspan>`;
    })
    .join('');
}

const plain = (spans) => spans.map((sp) => (typeof sp === 'string' ? sp : sp[0])).join('');

// Per-element keyframes with the delay baked in, so the loop stays choreographed.
function fadeKeyframes(name, from, riseFrom = 3) {
  const a = pct(from);
  const b = pct(from + 0.35);
  const out1 = pct(CYCLE * HOLD_END);
  const out2 = pct(CYCLE * HOLD_END + 0.6);
  return `@keyframes ${name}{0%,${a}%{opacity:0;transform:translateY(${riseFrom}px)}${b}%,${out1}%{opacity:1;transform:none}${out2}%,100%{opacity:0;transform:none}}`;
}

function typeKeyframes(name, from, dur, width) {
  const a = pct(from);
  const b = pct(from + dur);
  const out1 = pct(CYCLE * HOLD_END);
  const out2 = pct(CYCLE * HOLD_END + 0.6);
  return `@keyframes ${name}{0%,${a}%{width:0;opacity:1}${b}%,${out1}%{width:${width}px;opacity:1}${out2}%,100%{width:${width}px;opacity:0}}`;
}

function swapOutKeyframes(name, from, at) {
  const a = pct(from);
  const b = pct(from + 0.35);
  const c = pct(at);
  const d = pct(at + 0.7);
  return `@keyframes ${name}{0%,${a}%{opacity:0}${b}%,${c}%{opacity:1}${d}%,100%{opacity:0}}`;
}

function swapInKeyframes(name, at) {
  const c = pct(at);
  const d = pct(at + 0.7);
  const out1 = pct(CYCLE * HOLD_END);
  const out2 = pct(CYCLE * HOLD_END + 0.6);
  return `@keyframes ${name}{0%,${c}%{opacity:0}${d}%,${out1}%{opacity:1}${out2}%,100%{opacity:0}}`;
}

// ---------- build -----------------------------------------------------------
const CHW = FS * 0.602; // monospace advance estimate (used ONLY for type-reveal width)
let css = '';
let body = '';
let y = 0;
let n = 0;

for (const ev of scene) {
  y += LH * (1 + (ev.gap ?? 0));
  n += 1;
  const id = `e${n}`;

  if (ev.kind === 'type') {
    const text = plain(ev.spans);
    const width = Math.ceil(text.length * CHW) + 2;
    css += typeKeyframes(`k${n}`, ev.t, ev.dur, width);
    css += `.${id} rect{animation:k${n} ${CYCLE}s steps(${text.length}) infinite}`;
    body += `<g class="${id}"><clipPath id="clip${n}"><rect x="${PAD}" y="${y - FS}" height="${LH}" width="0"/></clipPath>` +
      `<text x="${PAD}" y="${y}" clip-path="url(#clip${n})">${spansToTspans(ev.spans)}</text></g>`;
  } else if (ev.kind === 'show') {
    css += fadeKeyframes(`k${n}`, ev.t);
    css += `.${id}{opacity:0;animation:k${n} ${CYCLE}s ease-out infinite}`;
    body += `<text class="${id}" x="${PAD}" y="${y}">${spansToTspans(ev.spans)}</text>`;
  } else if (ev.kind === 'swap') {
    css += swapOutKeyframes(`k${n}a`, ev.t, ev.at) + swapInKeyframes(`k${n}b`, ev.at);
    css += `.${id}a{opacity:0;animation:k${n}a ${CYCLE}s ease-out infinite}` +
      `.${id}b{opacity:0;animation:k${n}b ${CYCLE}s ease-out infinite}`;
    body += `<text class="${id}a" x="${PAD}" y="${y}">${spansToTspans(ev.a)}</text>` +
      `<text class="${id}b" x="${PAD}" y="${y}">${spansToTspans(ev.b)}</text>`;
  }
}

const H = y + LH + 18 + 34; // content + bottom pad + title bar
const BAR = 34;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Terminal demo: cloak wrap sanitizes an incident log into reserved-range decoys for the LLM, then restores the real values in its reply.">
<style>
text{font-family:${T.font};font-size:${FS}px;fill:${T.text};white-space:pre}
.c-text{fill:${T.text}}.c-faint{fill:${T.faint}}.c-amber{fill:${T.amber}}.c-cyan{fill:${T.cyan}}
${css}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important}
  text{opacity:1!important}
  [class$="a"][class^="e"]{opacity:0!important}
  clipPath rect{width:${W}px!important}
}
</style>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="${T.ink}" stroke="${T.edge}"/>
<rect x="1" y="1" width="${W - 2}" height="${BAR}" rx="10" fill="${T.bar}"/>
<rect x="1" y="${BAR - 10}" width="${W - 2}" height="10" fill="${T.bar}"/>
<circle cx="22" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<circle cx="40" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<circle cx="58" cy="${BAR / 2 + 1}" r="4.5" fill="${T.edge}"/>
<text x="${W / 2}" y="${BAR / 2 + 5}" text-anchor="middle" class="c-faint" style="font-size:11px">cloak wrap — check your secrets at the door</text>
<g transform="translate(0 ${BAR + 10})">
${body}
</g>
<line x1="1" y1="${BAR}" x2="${W - 1}" y2="${BAR}" stroke="${T.edge}" stroke-width="1"/>
</svg>
`;

writeFileSync('docs/cli-demo.svg', svg);
console.log(`Wrote docs/cli-demo.svg (${(svg.length / 1024).toFixed(1)} KB, ${CYCLE}s loop, ${n} elements)`);
