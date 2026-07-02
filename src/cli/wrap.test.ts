import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { engine } from '../core/index';
import { makeLineRestorer } from './wrap';
import { loadPacks, packPaths } from './packs';
import { parseArgs } from './args';
import { cmdScan } from './commands';

describe('wrap line restorer', () => {
  it('restores decoys across arbitrary chunk boundaries, streaming line by line', () => {
    const r = engine.sanitize('peer 10.9.9.9 mail admin@bank.com');
    const decoyed = r.sanitized;
    let out = '';
    const restorer = makeLineRestorer(
      () => r.mapping,
      (s) => (out += s),
    );
    // Feed the child's output in awkward chunks, splitting mid-decoy.
    const reply = `Root cause: ${decoyed}\nRotate credentials now.\nDone`;
    for (let i = 0; i < reply.length; i += 7) restorer.push(reply.slice(i, i + 7));
    restorer.flush();
    expect(out).toBe('Root cause: peer 10.9.9.9 mail admin@bank.com\nRotate credentials now.\nDone');
  });
});

describe('term packs', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    delete process.env.CLOAK_PACKS;
  });

  it('loads and merges packs from flag and env; bare strings become CUSTOM terms', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloak-pack-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeFile(a, JSON.stringify({ customTerms: [{ value: 'Judge Kwan', type: 'PERSON' }, 'UTB-CMS'] }));
    await writeFile(b, JSON.stringify({ whitelist: ['pacer.uscourts.gov'] }));
    process.env.CLOAK_PACKS = a;
    const merged = await loadPacks(packPaths(b));
    expect(merged.customTerms).toEqual([{ value: 'Judge Kwan', type: 'PERSON' }, { value: 'UTB-CMS', type: undefined }]);
    expect(merged.whitelist).toEqual(['pacer.uscourts.gov']);
  });

  it('pack terms are replaced and pack whitelist is respected end-to-end', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloak-pack-'));
    const p = join(dir, 'moss.json');
    await writeFile(
      p,
      JSON.stringify({ customTerms: [{ value: 'Judge Kwan', type: 'PERSON' }], whitelist: ['pacer.uscourts.gov'] }),
    );
    const packs = await loadPacks([p]);
    const r = engine.sanitize('Judge Kwan filed via pacer.uscourts.gov', {
      customTerms: packs.customTerms,
      whitelist: packs.whitelist,
    });
    expect(r.sanitized).not.toContain('Judge Kwan');
    expect(r.sanitized).toContain('pacer.uscourts.gov');
  });

  it('throws a clear error on an unreadable pack (never silently skips terms)', async () => {
    await expect(loadPacks(['/nonexistent/pack.json'])).rejects.toThrow(/term pack/i);
  });
});

describe('scan with multiple files (pre-commit contract)', () => {
  it('exits 3 if ANY file has secrets, 0 when all clean', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'cloak-scan-'));
    const clean = join(dir2, 'clean.txt');
    const dirty = join(dir2, 'dirty.txt');
    await writeFile(clean, 'nothing here');
    await writeFile(dirty, 'ssh root@10.0.0.1');
    expect(await cmdScan(parseArgs(['scan', clean, dirty, '--json']))).toBe(3);
    expect(await cmdScan(parseArgs(['scan', clean, '--json']))).toBe(0);
    await rm(dir2, { recursive: true, force: true });
  });
});
