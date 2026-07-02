import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Regression gate for a bug class that has now bitten this repo TWICE: a stray
// NUL byte inside a template-literal separator (engine.ts's mapping key, then
// commands.ts's guard dedup key). A NUL is invisible in editors, makes git
// treat the file as binary, and can silently break string comparisons. No
// source file may contain any control byte other than \n and \t.
//
// The pattern is built via String.fromCharCode ON PURPOSE — an escape-sequence
// literal here could itself be corrupted into raw control bytes (it happened
// while writing this very test).

const cc = String.fromCharCode;
const CONTROL = new RegExp('[' + cc(0) + '-' + cc(8) + cc(11) + cc(12) + cc(14) + '-' + cc(31) + ']');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('source hygiene', () => {
  it('no control bytes (NUL etc.) anywhere under src/', () => {
    const bad: string[] = [];
    for (const f of walk('src')) {
      const text = readFileSync(f, 'utf8');
      const m = CONTROL.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${f}:${line} contains 0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')}`);
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });
});
