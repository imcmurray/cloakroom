// Generate docs/doors/*.svg — the four clickable "door" chips under the
// architecture diagram in the README.
//
// Why they exist as SEPARATE images: GitHub embeds README images as plain img
// elements, so nothing inside one image can be a link. Four small images, each
// wrapped in its own anchor in the README, is the only way each door can
// really navigate somewhere. They keep the carousel personality: each chip
// pulses its ring during its own quarter of a shared 20s cycle (phases baked
// into keyframe percentages, so the stagger survives looping).
//
// Usage: node scripts/gen-door-chips.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const T = {
  ink: '#131926',
  edge: '#2A3242',
  cyan: '#4FD6C4',
  idle: '#8B96AA',
  lit: '#E8F2FA',
  sans: `ui-sans-serif,system-ui,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  mono: `'JetBrains Mono','Fira Code','SF Mono',ui-monospace,Menlo,Consolas,monospace`,
};

// Order matches the README's numbered sections (pulse phase follows order).
const DOORS = [
  { file: 'browser.svg', label: 'browser app', w: 132, mono: false },
  { file: 'wrap.svg', label: 'cloak wrap', w: 132, mono: true },
  { file: 'gate.svg', label: 'pre-commit gate', w: 150, mono: false },
  { file: 'hooks.svg', label: 'Claude Code hooks', w: 160, mono: false },
];

mkdirSync('docs/doors', { recursive: true });

DOORS.forEach((d, i) => {
  // Each door owns one quarter of the 20s cycle: [i*25%, i*25%+23.5%] lit.
  const s = (i * 25).toFixed(1);
  const litEnd = (i * 25 + 23.5).toFixed(1);
  const end = ((i + 1) * 25).toFixed(1);
  const wrap0 = i === 0; // door 0's window starts at 0%, no lead-in needed
  const ring = wrap0
    ? `0%,${litEnd}%{stroke:${T.cyan}}${end}%,100%{stroke:${T.edge}}`
    : `0%,${s}%{stroke:${T.edge}}${(+s + 1.5).toFixed(1)}%,${litEnd}%{stroke:${T.cyan}}${end}%,100%{stroke:${T.edge}}`;
  const lbl = wrap0
    ? `0%,${litEnd}%{fill:${T.lit}}${end}%,100%{fill:${T.idle}}`
    : `0%,${s}%{fill:${T.idle}}${(+s + 1.5).toFixed(1)}%,${litEnd}%{fill:${T.lit}}${end}%,100%{fill:${T.idle}}`;

  const W = d.w + 8;
  // Everything is namespaced per chip — keyframe names AND selectors (classes,
  // not bare element selectors). Inline SVG styles are document-global: if the
  // four files are ever inlined into one page, bare `rect{animation:…}` rules
  // from the last file would capture every chip's rect (this actually happened
  // in the verification harness).
  const k = d.file.replace('.svg', '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 38" width="${W}" height="38" role="img" aria-label="${d.label} — jump to this section">
<style>
@keyframes ring_${k}{${ring}}
@keyframes lbl_${k}{${lbl}}
.chip_${k}{animation:ring_${k} 20s linear infinite}
.lbl_${k}{font-family:${d.mono ? T.mono : T.sans};font-size:12px;animation:lbl_${k} 20s linear infinite}
@media (prefers-reduced-motion:reduce){.chip_${k},.lbl_${k}{animation:none}.lbl_${k}{fill:#C9D2E0}}
</style>
<rect class="chip_${k}" x="4" y="4" width="${d.w}" height="30" rx="15" fill="${T.ink}" stroke="${T.edge}" stroke-width="1.4"/>
<text class="lbl_${k}" x="${W / 2}" y="23" text-anchor="middle" fill="${T.idle}">${d.label}</text>
</svg>
`;
  writeFileSync(`docs/doors/${d.file}`, svg);
  console.log(`Wrote docs/doors/${d.file} (${d.label}, lit ${s}%–${litEnd}%)`);
});
