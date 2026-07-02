// Tiny zero-dependency argv parser. Kept hand-rolled on purpose: this is a
// security tool, and every runtime dependency is attack surface we'd rather not
// audit. Supports `--flag value`, `--flag=value`, boolean `--flag`, short `-`
// for stdin, and a single optional positional (the input file).

export interface ParsedArgs {
  command: string;
  /** First non-flag positional, or '-' / undefined. Usually the input file. */
  input?: string;
  /** ALL non-flag positionals, in order (pre-commit passes many filenames). */
  inputs: string[];
  /** Everything after a literal `--`: the child command for `cloak wrap`. */
  passthrough: string[];
  flags: Record<string, string | true>;
}

/** Flags that take no value (presence = true). */
const BOOLEAN_FLAGS = new Set([
  'audit',
  'json',
  'merge',
  'force',
  'help',
  'version',
  'no-color',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const inputs: string[] = [];
  const passthrough: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      // Everything after a literal `--` belongs to the wrapped child command.
      passthrough.push(...rest.slice(i + 1));
      break;
    }
    if (tok === '-') {
      inputs.push('-');
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
    inputs.push(tok);
  }

  return { command, input: inputs[0], inputs, passthrough, flags };
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
