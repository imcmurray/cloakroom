// Node I/O helpers for the CLI: stdin slurp, hidden passphrase prompt, and the
// bridge-file read/write. Deliberately Node-only — kept out of src/core so the
// core stays environment-agnostic.

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/** Read all of stdin as UTF-8. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve the input text: a file path, '-' / undefined for stdin. */
export async function readInput(input?: string): Promise<string> {
  if (input === undefined || input === '-') return readStdin();
  return readFile(input, 'utf8');
}

/**
 * Resolve the passphrase used to encrypt/decrypt a bridge file.
 * Priority: $CLOAK_PASS (for non-interactive pipelines) → hidden TTY prompt.
 * Never accepted as a CLI flag, to keep it out of shell history and `ps`.
 */
export async function resolvePassphrase(purpose: 'encrypt' | 'decrypt'): Promise<string> {
  const fromEnv = process.env.CLOAK_PASS;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new CliError(
      'A bridge passphrase is required but no TTY is available. ' +
        'Set $CLOAK_PASS for non-interactive use.',
    );
  }
  const verb = purpose === 'encrypt' ? 'Create' : 'Enter';
  return promptHidden(`${verb} bridge passphrase: `);
}

/** Prompt on the TTY without echoing keystrokes. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const stdout = process.stderr as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
    // Mute echo: overwrite readline's output writer while the prompt is active.
    const origWrite = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
      if (s.includes(prompt)) origWrite.call(rl, s);
      // swallow the echoed characters
    };
    void stdout;
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

/** Read a bridge file's raw encrypted blob from disk. */
export async function readBridge(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new CliError(`Cannot read bridge file: ${path}`);
  }
}

/** Write a bridge file's encrypted blob to disk. */
export async function writeBridge(path: string, blob: string): Promise<void> {
  await writeFile(path, blob, { encoding: 'utf8', mode: 0o600 });
}

/** A user-facing error whose message is printed without a stack trace. */
export class CliError extends Error {}

export function out(s: string): void {
  process.stdout.write(s);
}
export function err(s: string): void {
  process.stderr.write(s + '\n');
}
