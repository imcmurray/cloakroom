// `cloak wrap -- <command> [args…]` — run ANY command inside the cloak.
//
// stdin and the child's own arguments are sanitized on the way in; the child's
// stdout is restored line-by-line on the way out. Sanitize and restore happen
// in ONE process, so the default needs no bridge file, no passphrase, no
// setup — the mapping lives and dies in memory:
//
//   cat incident.log | cloak wrap -- claude -p "diagnose this failure"
//   cat ticket.txt   | cloak wrap -- llm "summarize"
//
// The wrapped command sees only reserved-range decoys; your terminal shows the
// real values. Pass --bridge (with $CLOAK_PASS) to ALSO persist the mapping for
// restoring later replies pasted from elsewhere.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { MappingEntry } from '../core/index';
import { engine, encryptBridge, decryptBridge } from '../core/index';
import type { ParsedArgs } from './args';
import { buildOptions } from './commands';
import { CliError, err, readBridge, readStdin, resolvePassphrase, writeBridge } from './io';

/** Line-buffered restore: placeholders never contain newlines, so restoring
 *  per-line is lossless AND preserves streaming output from the child. */
export function makeLineRestorer(
  mapping: () => MappingEntry[],
  write: (s: string) => void,
): { push: (chunk: string) => void; flush: () => void } {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) write(engine.desanitize(line, mapping()) + '\n');
    },
    flush() {
      if (buf) write(engine.desanitize(buf, mapping()));
      buf = '';
    },
  };
}

export async function cmdWrap(args: ParsedArgs): Promise<number> {
  const cmd = args.passthrough;
  if (cmd.length === 0) {
    throw new CliError('Usage: cloak wrap [options] -- <command> [args…]  (input on stdin)');
  }

  const opts = await buildOptions(args.flags);
  const bridgePath = typeof args.flags['bridge'] === 'string' ? (args.flags['bridge'] as string) : undefined;

  // Optional persistence: --merge into an existing bridge keeps decoys
  // consistent across wrap invocations. Needs $CLOAK_PASS (stdin is the pipe,
  // so there is no TTY to prompt on).
  let pass: string | undefined;
  if (bridgePath) {
    pass = await resolvePassphrase(args.flags['merge'] && existsSync(bridgePath) ? 'decrypt' : 'encrypt');
    if (args.flags['merge'] === true && existsSync(bridgePath)) {
      try {
        opts.priorMapping = (await decryptBridge(await readBridge(bridgePath), pass)).mapping;
      } catch {
        throw new CliError('Decryption failed — wrong passphrase or corrupt bridge file.');
      }
    } else if (existsSync(bridgePath) && args.flags['force'] !== true) {
      throw new CliError(
        `${bridgePath} already exists. Use --merge to accumulate into it or --force to overwrite.`,
      );
    }
  }

  // Sanitize stdin (if piped) and every child argument with ONE shared mapping,
  // so a secret appearing in both maps to the same decoy.
  const stdinText = process.stdin.isTTY ? '' : await readStdin();
  let result = engine.sanitize(stdinText, opts);
  let mapping = result.mapping;
  const sanitizedArgs = cmd.slice(1).map((a) => {
    const r = engine.sanitize(a, { ...opts, priorMapping: mapping });
    mapping = r.mapping;
    return r.sanitized;
  });

  if (args.flags['audit']) {
    const masked = mapping.map((m) => `  ${m.type.padEnd(12)} → ${m.placeholder}`).join('\n');
    err(mapping.length ? `cloak wrap: ${mapping.length} value(s) decoyed:\n${masked}` : 'cloak wrap: nothing to decoy.');
  }

  // Run the child: sanitized stdin + args in, restored stdout out, stderr through.
  const child = spawn(cmd[0], sanitizedArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  const restorer = makeLineRestorer(
    () => mapping,
    (s) => process.stdout.write(s),
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => restorer.push(chunk));
  if (stdinText) child.stdin.write(result.sanitized);
  child.stdin.end();

  const code: number = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new CliError(`Cannot run '${cmd[0]}': ${e.message}`)));
    child.on('close', (c) => resolve(c ?? 1));
  });
  restorer.flush();

  if (bridgePath && pass) {
    await writeBridge(bridgePath, await encryptBridge(mapping, pass, opts.mode ?? 'realistic'));
    err(`\nMapping saved (encrypted) → ${bridgePath}`);
  }
  return code;
}
