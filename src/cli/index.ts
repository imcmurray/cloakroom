// cloak — Cloakroom command-line interface.
//
// Strip PII/secrets out of text before it goes to any LLM, then restore the
// real data on the way back. Everything runs locally; the only artifact that
// contains the real mapping is an AES-256-GCM encrypted bridge file.

import { parseArgs } from './args';
import { CliError, err } from './io';
import { cmdHook, cmdInspect, cmdRestore, cmdSanitize, cmdScan } from './commands';

const VERSION = '0.1.0';

const HELP = `cloak — check your secrets at the door, get them back on the way out.

USAGE
  cloak <command> [FILE|-] [options]

COMMANDS
  sanitize   Replace secrets with realistic decoys; write an encrypted mapping.
  restore    Re-inflate real data from a sanitized/AI-returned text.
  scan       Detect-only. Prints a masked audit; exits 3 if anything is found.
  inspect    Show the masked audit of an existing bridge file.
  hook       Claude Code hook adapter (guard|sanitize|restore); reads a hook
             event as JSON on stdin, writes a hook response on stdout.
  help       Show this help. (--version prints the version.)

OPTIONS
  --bridge <path>        Encrypted mapping file. Required for sanitize/restore/inspect.
  --mode <realistic|token>   Decoy style. Default: realistic.
  --types <A,B,...>      Only replace these entity types (e.g. IPV4,EMAIL,SSN).
  --whitelist <a,b,...>  Literal strings to never replace (e.g. localhost).
  --custom <a,b,...>     Extra sensitive literals to always replace (names, codenames).
  --min-confidence <n>   Drop detections below this confidence (0..1). Default 0.5.
  --merge                Accumulate into an existing --bridge instead of overwriting
                         it, keeping decoys consistent across calls (session use).
  --force                Overwrite an existing --bridge, discarding its mapping.
                         Without --merge or --force, sanitize refuses to clobber one.
  --audit                Print the masked audit to stderr after sanitize.
  --json                 Machine-readable output on stdout.

PASSPHRASE
  Read from $CLOAK_PASS, else prompted (hidden) on the TTY. Never passed as a flag.

EXAMPLES
  cat incident.log | cloak sanitize --bridge case.cloak | pbcopy
  pbpaste | cloak restore --bridge case.cloak
  cloak scan src/ -  < app.log        # exit 3 if secrets present (CI guardrail)
  cloak inspect --bridge case.cloak
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags['version'] || args.command === 'version' || args.command === '--version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (args.flags['help'] || args.command === 'help' || args.command === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (args.command) {
    case 'sanitize':
      return cmdSanitize(args);
    case 'restore':
      return cmdRestore(args);
    case 'scan':
      return cmdScan(args);
    case 'inspect':
      return cmdInspect(args);
    case 'hook':
      return cmdHook(args);
    default:
      err(`Unknown command: ${args.command}\nRun 'cloak help' for usage.`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof CliError) {
      err('Error: ' + e.message);
      process.exit(1);
    }
    err('Unexpected error: ' + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
