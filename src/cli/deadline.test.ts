import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readdir, stat, chmod } from 'node:fs/promises';
import { build } from 'esbuild';

// The hook deadline only exists in the BUNDLED CLI (it re-loads itself as a
// worker thread, which the TypeScript source can't do under vitest), so these
// tests build the bundle into a temp dir and drive it like Claude Code does:
// a hook event on stdin, a hook response on stdout.

let dir: string;
let cli: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cloak-deadline-'));
  cli = join(dir, 'cloak.mjs');
  await build({
    entryPoints: ['src/cli/index.ts'],
    outfile: cli,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'silent',
  });
}, 30000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function hook(mode: string, evt: unknown, extra: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('node', [cli, 'hook', mode, ...extra], {
    input: JSON.stringify(evt),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

const SECRET = 'connect 10.9.9.9 as admin@bank.com';
const bashEvt = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: SECRET, stderr: '' } };

describe('hook deadline (bundled CLI, worker thread)', () => {
  it('runs the hook in a worker and returns its normal response', () => {
    const r = hook('guard', bashEvt);
    expect(r.status).toBe(0);
    expect(r.out.hookSpecificOutput.updatedToolOutput.stdout).toContain('cloak guard');
  });

  it('PostToolUse: withholds the output when the deadline passes', () => {
    // No worker can start and finish in 1 ms, so this always hits the deadline.
    const r = hook('guard', bashEvt, ['--deadline', '0.001']);
    expect(r.status).toBe(0);
    const out = r.out.hookSpecificOutput.updatedToolOutput.stdout as string;
    expect(out).toContain('took longer than 0.001s');
    expect(out).not.toContain('10.9.9.9');
  });

  it('PreToolUse: denies the call when the deadline passes', () => {
    const r = hook('restore', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'x' } }, [
      '--deadline',
      '0.001',
    ]);
    expect(r.out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('sanitize: persists the session bridge atomically (0600, no temp files left)', async () => {
    const sess = await mkdtemp(join(dir, 'sess-'));
    const env = { CLOAK_SESSION_BRIDGE: join(sess, 'session.cloak'), CLOAK_PASS: 'deadline-test' };
    expect(hook('sanitize', bashEvt, [], env).status).toBe(0);
    // A pre-existing bridge someone loosened to 0644 must come back 0600.
    await chmod(env.CLOAK_SESSION_BRIDGE, 0o644);
    const r = hook('sanitize', bashEvt, [], env);
    expect(r.out.hookSpecificOutput.updatedToolOutput.stdout).not.toContain('10.9.9.9');
    expect(r.out.hookSpecificOutput.updatedToolOutput.stdout).not.toContain('withheld');
    expect((await stat(env.CLOAK_SESSION_BRIDGE)).mode & 0o777).toBe(0o600);
    expect((await readdir(sess)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
