// Tiny zero-dependency argv parser. Kept hand-rolled on purpose: this is a
// security tool, and every runtime dependency is attack surface we'd rather not
// audit. Supports `--flag value`, `--flag=value`, boolean `--flag`, short `-`
// for stdin, and a single optional positional (the input file).

export interface ParsedArgs {
  command: string;
  /** First non-flag positional, or '-' / undefined. Usually the input file. */
  input?: string;
  flags: Record<string, string | true>;
}

/** Flags that take no value (presence = true). */
const BOOLEAN_FLAGS = new Set([
  'audit',
  'json',
  'merge',
  'help',
  'version',
  'no-color',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  let input: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '-') {
      input = '-';
      continue;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      // Consume the next token as the value unless it looks like another flag.
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true; // tolerate a valueless non-boolean flag
      } else {
        flags[body] = next;
        i++;
      }
      continue;
    }
    // First bare token is the positional input; ignore extras.
    if (input === undefined) input = tok;
  }

  return { command, input, flags };
}

/** Read a flag as a comma-separated list, trimming blanks. */
export function listFlag(v: string | true | undefined): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read a flag as a float, or undefined if absent/invalid. */
export function numberFlag(v: string | true | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
