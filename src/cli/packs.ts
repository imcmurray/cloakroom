// Term packs: shareable, versioned detection dictionaries.
//
// A pack is a plain JSON file declaring org-specific sensitive literals
// (people, org names, codenames → always replaced) and known-safe literals
// (internal hostnames that would otherwise trip detectors → never replaced).
// Packs make Cloakroom deployable for a *team*: one maintained dictionary,
// loaded by everyone, instead of per-user --custom flags.
//
// IMPORTANT, stated plainly: a term pack is itself a sensitive artifact — it
// is literally a list of the names you consider sensitive. Treat it like an
// internal document. Keep real packs in private repos / internal shares; the
// example pack in integrations/packs/ uses fictional names for exactly this
// reason.
//
// Sources, merged in order (later wins nothing — entries just accumulate):
//   1. $CLOAK_PACKS — colon-separated paths (works for hooks, which take no flags
//      from the user's shell)
//   2. --pack a.json,b.json — explicit CLI flag

import { readFile } from 'node:fs/promises';
import { parseTermPack, type CustomTerm } from '../core/index';
import { CliError } from './io';

export interface PackOptions {
  customTerms: CustomTerm[];
  whitelist: string[];
}

/** Resolve pack file paths from the env var and the --pack flag. */
export function packPaths(flagValue: string | true | undefined): string[] {
  const paths: string[] = [];
  const env = process.env.CLOAK_PACKS;
  if (env) paths.push(...env.split(':').map((s) => s.trim()).filter(Boolean));
  if (typeof flagValue === 'string') {
    paths.push(...flagValue.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return paths;
}

/** Load and merge packs. Throws CliError on unreadable/malformed packs —
 *  a silently-skipped pack would mean silently-unprotected terms. Parsing and
 *  validation are shared with the browser app via core parseTermPack. */
export async function loadPacks(paths: string[]): Promise<PackOptions> {
  const out: PackOptions = { customTerms: [], whitelist: [] };
  for (const p of paths) {
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch {
      throw new CliError(`Cannot read term pack: ${p} (missing or unreadable)`);
    }
    try {
      const pack = parseTermPack(text);
      out.customTerms.push(...pack.customTerms);
      out.whitelist.push(...pack.whitelist);
    } catch (e) {
      throw new CliError(`Invalid term pack ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
