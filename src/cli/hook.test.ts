import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { hookGuard, hookSanitize, hookRestore } from './commands';

// The hook handlers read $CLOAK_SESSION_BRIDGE / $CLOAK_PASS at call time.
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

describe('hook sanitize → restore (transparent round trip)', () => {
  it('shows the model decoys and writes real values back to disk', async () => {
    const san = await hookSanitize({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_result: { output: SECRET },
    });
    const decoyed = (san as any).hookSpecificOutput.updatedToolOutput as string;
    // the model never sees the real secret
    expect(decoyed).not.toContain('10.9.9.9');
    expect(decoyed).not.toContain('admin@bank.com');

    // the model echoes the decoys into a Write; restore re-inflates them
    const res = await hookRestore({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: decoyed },
    });
    const toDisk = (res as any).hookSpecificOutput.updatedInput.content as string;
    expect(toDisk).toBe(SECRET);
  });

  it('sanitize is a no-op when the session env is not configured', async () => {
    delete process.env.CLOAK_SESSION_BRIDGE;
    const san = await hookSanitize({ tool_result: { output: SECRET } });
    expect(san).toBeNull();
  });
});

describe('hook guard', () => {
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
