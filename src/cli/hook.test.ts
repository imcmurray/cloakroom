import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { hookGuard, hookSanitize, hookRestore } from './commands';

// Payload shapes below mirror what Claude Code actually sends (verified against
// the installed binary): PostToolUse carries `tool_response`, and the response
// is tool-shaped — Bash `{stdout, stderr, ...}`, Read `{file: {content, ...}}`.

let dir: string;
const SECRET = 'connect 10.9.9.9 as admin@bank.com';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cloak-hook-'));
  process.env.CLOAK_SESSION_BRIDGE = join(dir, 'session.cloak');
  process.env.CLOAK_PASS = 'test-pass';
});
afterEach(async () => {
  delete process.env.CLOAK_SESSION_BRIDGE;
  delete process.env.CLOAK_PASS;
  await rm(dir, { recursive: true, force: true });
});

describe('hook sanitize (PostToolUse, real payload shapes)', () => {
  it('sanitizes a Bash tool_response and PRESERVES its object shape', async () => {
    const resp = await hookSanitize({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: SECRET, stderr: 'warn: 10.9.9.9 slow', interrupted: false },
    });
    const updated = (resp as any).hookSpecificOutput.updatedToolOutput;
    // shape preserved — Claude Code validates this against the tool's output schema
    expect(Object.keys(updated).sort()).toEqual(['interrupted', 'stderr', 'stdout']);
    expect(updated.interrupted).toBe(false);
    // both text fields sanitized, with the SAME decoy for the shared IP
    expect(updated.stdout).not.toContain('10.9.9.9');
    expect(updated.stderr).not.toContain('10.9.9.9');
    const decoy = updated.stdout.match(/\d+\.\d+\.\d+\.\d+/)![0];
    expect(updated.stderr).toContain(decoy);
  });

  it('sanitizes a Read tool_response nested under file.content, leaving filePath alone', async () => {
    const resp = await hookSanitize({
      tool_name: 'Read',
      tool_response: { type: 'text', file: { filePath: '/srv/app.log', content: SECRET, numLines: 1 } },
    });
    const updated = (resp as any).hookSpecificOutput.updatedToolOutput;
    expect(updated.file.filePath).toBe('/srv/app.log'); // paths untouched (already in tool_input)
    expect(updated.file.numLines).toBe(1);
    expect(updated.file.content).not.toContain('admin@bank.com');
  });

  it('round-trips: restore re-inflates the decoys the model echoes into a Write', async () => {
    const san = await hookSanitize({ tool_name: 'Bash', tool_response: { stdout: SECRET, stderr: '' } });
    const decoyed = (san as any).hookSpecificOutput.updatedToolOutput.stdout as string;
    const res = await hookRestore({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: decoyed },
    });
    expect((res as any).hookSpecificOutput.updatedInput.content).toBe(SECRET);
  });

  it('falls back to tool_result for non-Claude-Code harnesses', async () => {
    const resp = await hookSanitize({ tool_result: { output: SECRET } });
    expect((resp as any).hookSpecificOutput.updatedToolOutput.output).not.toContain('10.9.9.9');
  });

  it('FAILS CLOSED when the session env is missing: withholds text instead of leaking', async () => {
    delete process.env.CLOAK_SESSION_BRIDGE;
    const resp = await hookSanitize({ tool_name: 'Bash', tool_response: { stdout: SECRET, stderr: '' } });
    const updated = (resp as any).hookSpecificOutput.updatedToolOutput;
    expect(updated.stdout).not.toContain('10.9.9.9');
    expect(updated.stdout).toContain('withheld');
  });

  it('no-ops on a response with no text-bearing fields (e.g. an image read)', async () => {
    const resp = await hookSanitize({ tool_name: 'Read', tool_response: { file: { base64: 'AAAA', type: 'image/png' } } });
    expect(resp).toBeNull();
  });
});

describe('hook restore (PreToolUse)', () => {
  it('restores decoys inside a Bash command too', async () => {
    const san = await hookSanitize({ tool_name: 'Bash', tool_response: { stdout: SECRET, stderr: '' } });
    const decoyIp = ((san as any).hookSpecificOutput.updatedToolOutput.stdout as string).match(/\d+\.\d+\.\d+\.\d+/)![0];
    const res = await hookRestore({ tool_name: 'Bash', tool_input: { command: `ping ${decoyIp}` } });
    expect((res as any).hookSpecificOutput.updatedInput.command).toBe('ping 10.9.9.9');
  });

  it('FAILS CLOSED when the session env is missing: denies instead of writing decoys', async () => {
    delete process.env.CLOAK_PASS;
    const res = await hookRestore({ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'anything' } });
    expect((res as any).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('no-ops on tool_input with no restorable text fields', async () => {
    expect(await hookRestore({ tool_name: 'Glob', tool_input: { pattern: '*.ts' } })).toBeNull();
  });
});

describe('hook guard (PreToolUse)', () => {
  it('denies reading a file that contains secrets', async () => {
    const f = join(dir, 'secrets.txt');
    await writeFile(f, SECRET, 'utf8');
    const resp = await hookGuard({ tool_name: 'Read', tool_input: { file_path: f } });
    expect((resp as any).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows (no-op) a clean file', async () => {
    const f = join(dir, 'clean.txt');
    await writeFile(f, 'nothing sensitive here', 'utf8');
    expect(await hookGuard({ tool_name: 'Read', tool_input: { file_path: f } })).toBeNull();
  });
});
