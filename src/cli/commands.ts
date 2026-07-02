// Command implementations. Each returns an exit code. All plaintext handling
// delegates to @cloakroom/core (src/core) — the same engine the browser uses.

import {
  engine,
  encryptBridge,
  decryptBridge,
  isLikelyDecoy,
  type AuditItem,
  type EntityType,
  type MappingEntry,
  type SanitizeOptions,
  type CustomTerm,
} from '../core/index';
import { loadSessionMapping, saveSessionMapping } from './session';
import { loadPacks, packPaths, type PackOptions } from './packs';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { listFlag, numberFlag, type ParsedArgs } from './args';
import {
  CliError,
  err,
  out,
  readBridge,
  readInput,
  readStdin,
  resolvePassphrase,
  writeBridge,
} from './io';

function requireBridge(flags: ParsedArgs['flags']): string {
  const b = flags['bridge'];
  if (typeof b !== 'string') {
    throw new CliError('Missing required --bridge <path> (the encrypted mapping file).');
  }
  return b;
}

export async function buildOptions(flags: ParsedArgs['flags']): Promise<SanitizeOptions> {
  const mode = flags['mode'];
  if (mode !== undefined && mode !== 'realistic' && mode !== 'token') {
    throw new CliError(`--mode must be 'realistic' or 'token', got '${String(mode)}'.`);
  }
  const packs = await loadPacks(packPaths(flags['pack']));
  const customTerms: CustomTerm[] = [
    ...packs.customTerms,
    ...(listFlag(flags['custom'])?.map((value) => ({ value })) ?? []),
  ];
  const whitelist = [...packs.whitelist, ...(listFlag(flags['whitelist']) ?? [])];
  return {
    mode: (mode as 'realistic' | 'token' | undefined) ?? 'realistic',
    enabledTypes: listFlag(flags['types']) as EntityType[] | undefined,
    whitelist: whitelist.length ? whitelist : undefined,
    customTerms: customTerms.length ? customTerms : undefined,
    minConfidence: numberFlag(flags['min-confidence']),
  };
}

function renderAudit(audit: AuditItem[]): string {
  if (audit.length === 0) return 'No sensitive values detected.';
  const rows = audit
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((a) => `  ${a.type.padEnd(12)} ${String(a.count).padStart(3)}×  ${a.preview}  → ${a.placeholder}`);
  return `Detected ${audit.length} distinct value(s):\n${rows.join('\n')}`;
}

export async function cmdSanitize(args: ParsedArgs): Promise<number> {
  const bridgePath = requireBridge(args.flags);
  const opts = await buildOptions(args.flags);
  const text = await readInput(args.input);
  const merge = args.flags['merge'] === true;

  // The bridge is the ONLY key that can restore earlier sanitized text.
  // Overwriting one silently is unrecoverable data loss, so refuse unless the
  // user chose to accumulate (--merge) or explicitly discard (--force).
  if (existsSync(bridgePath) && !merge && args.flags['force'] !== true) {
    throw new CliError(
      `${bridgePath} already exists. Use --merge to accumulate into it ` +
        `(keeps earlier text restorable) or --force to overwrite and discard the old mapping.`,
    );
  }

  // One passphrase for the whole op: needed to decrypt the prior bridge (merge)
  // and to re-encrypt the result.
  const pass = await resolvePassphrase(merge && existsSync(bridgePath) ? 'decrypt' : 'encrypt');

  if (merge && existsSync(bridgePath)) {
    const prior = await loadMapping(bridgePath, pass);
    opts.priorMapping = prior;
  }

  const result = engine.sanitize(text, opts);

  const blob = await encryptBridge(result.mapping, pass, opts.mode ?? 'realistic');
  await writeBridge(bridgePath, blob);

  if (args.flags['json']) {
    out(JSON.stringify({ sanitized: result.sanitized, audit: result.audit, bridge: bridgePath }));
  } else {
    out(result.sanitized);
    if (args.flags['audit']) err('\n' + renderAudit(result.audit));
    err(`\nMapping saved (encrypted) → ${bridgePath}`);
  }
  return 0;
}

export async function cmdRestore(args: ParsedArgs): Promise<number> {
  const bridgePath = requireBridge(args.flags);
  const text = await readInput(args.input);

  const blob = await readBridge(bridgePath);
  const pass = await resolvePassphrase('decrypt');
  let bridge;
  try {
    bridge = await decryptBridge(blob, pass);
  } catch {
    throw new CliError('Decryption failed — wrong passphrase or corrupt bridge file.');
  }

  const restored = engine.desanitize(text, bridge.mapping);
  const gaps = engine.reverseGaps(text, bridge.mapping);

  if (args.flags['json']) {
    out(
      JSON.stringify({
        restored,
        unrestored: gaps.map((g) => ({ type: g.type, placeholder: g.placeholder })),
      }),
    );
  } else {
    out(restored);
    if (gaps.length > 0) {
      err(
        `\n⚠ ${gaps.length} value(s) never reappeared in the input and could not be restored ` +
          `(the model may have paraphrased or dropped them): ${gaps.map((g) => g.type).join(', ')}`,
      );
    }
  }
  return 0;
}

export async function cmdScan(args: ParsedArgs): Promise<number> {
  const opts = await buildOptions(args.flags);
  // Accept MANY files (pre-commit passes the staged filenames); no files = stdin.
  const files = args.inputs.length > 0 ? args.inputs : [undefined];

  let total = 0;
  const perFile: Array<{ file: string; audit: AuditItem[] }> = [];
  for (const f of files) {
    const text = await readInput(f);
    // Detect-only: reuse the engine but discard the mapping entirely.
    const { audit } = engine.sanitize(text, opts);
    total += audit.length;
    perFile.push({ file: f ?? '-', audit });
  }

  if (args.flags['json']) {
    out(JSON.stringify({ found: total, files: perFile }));
  } else {
    for (const r of perFile) {
      if (files.length > 1 && r.audit.length > 0) err(`${r.file}:`);
      if (files.length === 1 || r.audit.length > 0) err(renderAudit(r.audit));
    }
    if (files.length > 1 && total === 0) err('No sensitive values detected.');
  }
  // Exit 3 on any hit so `cloak scan` composes as a pre-commit / CI guardrail.
  return total > 0 ? 3 : 0;
}

export async function cmdInspect(args: ParsedArgs): Promise<number> {
  const bridgePath = requireBridge(args.flags);
  const blob = await readBridge(bridgePath);
  const pass = await resolvePassphrase('decrypt');
  let bridge;
  try {
    bridge = await decryptBridge(blob, pass);
  } catch {
    throw new CliError('Decryption failed — wrong passphrase or corrupt bridge file.');
  }

  // Re-derive a masked audit from the mapping; never print originals in full.
  const audit: AuditItem[] = bridge.mapping.map((e) => ({
    type: e.type,
    placeholder: e.placeholder,
    detector: 'bridge',
    confidence: 1,
    count: e.count,
    preview: maskPreview(e.original),
  }));

  if (args.flags['json']) {
    out(JSON.stringify({ mode: bridge.mode, createdAt: bridge.createdAt, audit }));
  } else {
    err(`Bridge: ${bridgePath}  (mode=${bridge.mode}, created ${bridge.createdAt})`);
    err(renderAudit(audit));
  }
  return 0;
}

// Local copy of the engine's masking so inspect never depends on engine internals.
function maskPreview(value: string): string {
  if (value.length <= 4) return value[0] + '█'.repeat(Math.max(1, value.length - 1));
  return value.slice(0, 2) + '█'.repeat(Math.min(8, value.length - 4)) + value.slice(-2);
}

/** Decrypt a bridge file and return just its mapping. */
async function loadMapping(path: string, pass: string): Promise<MappingEntry[]> {
  const blob = await readBridge(path);
  try {
    return (await decryptBridge(blob, pass)).mapping;
  } catch {
    throw new CliError('Decryption failed — wrong passphrase or corrupt bridge file.');
  }
}

// ---------------------------------------------------------------------------
// Claude Code hook mode: `cloak hook <guard|sanitize|restore>`
//
// Reads a Claude Code hook event as JSON on stdin and writes a hook-response
// JSON on stdout. Keeps all logic in this one zero-dependency Node binary so
// the hooks need no jq/bash glue. Session state (the accumulating mapping) is
// an encrypted bridge at $CLOAK_SESSION_BRIDGE, unlocked by $CLOAK_PASS.
// ---------------------------------------------------------------------------

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /**
   * PostToolUse payload field. Claude Code sends `tool_response` (verified
   * against the installed binary's schema: {hook_event_name:"PostToolUse",
   * tool_name, tool_input, tool_response, tool_use_id}); `tool_result` is
   * accepted as a fallback for other harnesses.
   */
  tool_response?: unknown;
  tool_result?: unknown;
}

function emit(obj: unknown): void {
  out(JSON.stringify(obj));
}

function sessionBridge(): { path: string; pass: string } | null {
  const path = process.env.CLOAK_SESSION_BRIDGE;
  const pass = process.env.CLOAK_PASS;
  if (!path || !pass) return null;
  return { path, pass };
}

/**
 * Text-bearing fields inside a tool_response. Claude Code VALIDATES a hook's
 * updatedToolOutput against the tool's output schema (mismatch → the hook's
 * output is ignored), so we must return the SAME shape with only these fields
 * transformed — e.g. Bash `{stdout, stderr, ...}`, Read `{file: {content, ...}}`.
 * Deliberately NOT filePath/paths: those already reached the model via
 * tool_input (which PostToolUse cannot change), and mangling them can break
 * the harness's file-state tracking.
 */
const TEXT_FIELDS = new Set(['stdout', 'stderr', 'output', 'content', 'text']);

/**
 * Deep-copy a tool_response, applying `fn` to every text-bearing string field
 * (recursing through nested objects/arrays, e.g. Read's `file.content`).
 * `found` reports whether any text field existed at all — false for e.g. an
 * image read (`file.base64`), which has nothing cloak can sanitize.
 */
function transformResponseText(
  resp: unknown,
  fn: (s: string) => string,
): { updated: unknown; found: boolean } {
  if (typeof resp === 'string') return { updated: fn(resp), found: true };
  if (Array.isArray(resp)) {
    let found = false;
    const updated = resp.map((item) => {
      const r = transformResponseText(item, fn);
      found = found || r.found;
      return r.updated;
    });
    return { updated, found };
  }
  if (resp && typeof resp === 'object') {
    let found = false;
    const updated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resp as Record<string, unknown>)) {
      if (TEXT_FIELDS.has(k) && typeof v === 'string') {
        updated[k] = fn(v);
        found = true;
      } else if (v && typeof v === 'object') {
        const r = transformResponseText(v, fn);
        updated[k] = r.updated;
        found = found || r.found;
      } else {
        updated[k] = v;
      }
    }
    return { updated, found };
  }
  return { updated: resp, found: false };
}

/** A hook response object to serialize to stdout, or null for a no-op. */
type HookResponse = Record<string, unknown> | null;

export async function cmdHook(args: ParsedArgs): Promise<number> {
  const mode = args.input;
  let evt: HookEvent;
  try {
    evt = JSON.parse(await readStdin()) as HookEvent;
  } catch {
    return 0; // malformed event → no-op, never break the session
  }
  const packFlag = args.flags['pack'];
  let response: HookResponse;
  switch (mode) {
    case 'guard':
      response = await hookGuard(evt, packFlag);
      break;
    case 'sanitize':
      response = await hookSanitize(evt, packFlag);
      break;
    case 'restore':
      response = await hookRestore(evt);
      break;
    default:
      err(`Unknown hook mode: ${String(mode)} (expected guard|sanitize|restore)`);
      return 2;
  }
  if (response) emit(response);
  return 0;
}

const NO_PACKS: PackOptions = { customTerms: [], whitelist: [] };

/** Resolve term packs for a hook: $CLOAK_PACKS plus an optional --pack flag
 *  on the hook's command line. Throws CliError on an unreadable pack. */
async function hookPacks(packFlag?: string | true): Promise<PackOptions> {
  return loadPacks(packPaths(packFlag));
}

/** Were packs explicitly configured (so a load failure must fail closed)? */
function packsConfigured(packFlag?: string | true): boolean {
  return Boolean(process.env.CLOAK_PACKS) || typeof packFlag === 'string';
}

/** Fail-closed response when configured term packs can't be loaded in guard mode. */
function guardPackFailure(evt: HookEvent): HookResponse {
  const resp = evt.tool_response ?? evt.tool_result;
  if (evt.hook_event_name === 'PostToolUse' && resp !== undefined && resp !== null) {
    const notice = '[cloak guard: term packs unreadable ($CLOAK_PACKS / --pack) — output withheld from context.]';
    const { updated, found } = transformResponseText(resp, (s) => (s ? notice : s));
    return found
      ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } }
      : null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Cloakroom: term packs are configured but unreadable ($CLOAK_PACKS / --pack), so the guard ' +
        'cannot check org-specific terms. Fix the pack path before reading files.',
    },
  };
}

/**
 * Detect real secrets in a text, ignoring Cloakroom's own reserved-range decoys
 * (already-sanitized content must not re-trip the guard). Pack terms count as
 * secrets; pack whitelist entries never do.
 */
function realSecretsIn(text: string, packs: PackOptions = NO_PACKS): MappingEntry[] {
  return engine
    .sanitize(text, { customTerms: packs.customTerms, whitelist: packs.whitelist })
    .mapping.filter((m) => !isLikelyDecoy(m.type, m.original));
}

/**
 * Guard: keep raw secrets out of the model's context WITHOUT needing a session
 * bridge or env — it never transforms, it only blocks/withholds.
 *   - PreToolUse (Read): deny reading a secret-laden file.
 *   - PostToolUse (Bash/Grep): if the tool's output contains secrets, replace it
 *     with a short notice so the raw text never reaches the model. This closes
 *     the `cat secrets.txt`-via-shell bypass of the Read guard.
 * Fail-open (allow) on internal errors — this is a tripwire, not the primary
 * control; the deny/withhold paths themselves are the protection.
 */
export async function hookGuard(evt: HookEvent, packFlag?: string | true): Promise<HookResponse> {
  // Term packs: if explicitly configured but unreadable, fail CLOSED — a
  // silently-skipped pack means silently-unguarded names.
  let packs = NO_PACKS;
  try {
    packs = await hookPacks(packFlag);
  } catch {
    if (packsConfigured(packFlag)) return guardPackFailure(evt);
  }
  try {
    // PostToolUse branch: scan tool output, withhold if it carries real secrets.
    const resp = evt.tool_response ?? evt.tool_result;
    if (evt.hook_event_name === 'PostToolUse' && resp !== undefined && resp !== null) {
      const found = new Map<string, MappingEntry>();
      transformResponseText(resp, (s) => {
        for (const m of realSecretsIn(s, packs)) found.set(`${m.type}:${m.original}`, m);
        return s;
      });
      if (found.size === 0) return null;
      const types = [...new Set([...found.values()].map((m) => m.type))].join(', ');
      const notice =
        `[cloak guard: this output contained ${found.size} PII/secret value(s) (${types}) ` +
        `and was withheld from context. Run the command through 'cloak sanitize' (or enable ` +
        `the transparent profile) to work on a decoyed copy, or ask the user how to proceed.]`;
      const { updated } = transformResponseText(resp, (s) => (s ? notice : s));
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
    }

    // PreToolUse branch: deny reading a secret-laden file.
    const file = evt.tool_input?.['file_path'];
    if (typeof file !== 'string' || !existsSync(file)) return null;
    const secrets = realSecretsIn(await readFile(file, 'utf8'), packs);
    if (secrets.length === 0) return null;
    const types = [...new Set(secrets.map((m) => m.type))].join(', ');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Cloakroom: ${file} contains ${secrets.length} PII/secret value(s) (${types}). ` +
          `Sanitize it with 'cloak sanitize' first, or read a redacted copy — ` +
          `don't pull raw secrets into the model's context.`,
      },
    };
  } catch {
    return null;
  }
}

/**
 * PostToolUse sanitize: replace a tool's output with a sanitized version before
 * the model sees it, accumulating the mapping into the session bridge.
 * Fail-CLOSED: if sanitization can't run, withhold the raw output rather than
 * leak it.
 */
export async function hookSanitize(evt: HookEvent, packFlag?: string | true): Promise<HookResponse> {
  const resp = evt.tool_response ?? evt.tool_result;
  if (resp === undefined || resp === null) return null;

  // Fail-CLOSED contract: if this hook is wired up (the profile matched this
  // tool) but we cannot sanitize — env missing, bridge unreadable, any error —
  // we withhold the text rather than let raw secrets flow into context.
  const withhold = (why: string): HookResponse => {
    const msg = `[cloak: output withheld from context — ${why}]`;
    const { updated, found } = transformResponseText(resp, (s) => (s ? msg : s));
    if (!found) return null; // nothing text-bearing (e.g. an image read) → nothing to leak
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
  };

  const session = sessionBridge();
  if (!session) {
    return withhold('transparent mode is installed but $CLOAK_SESSION_BRIDGE / $CLOAK_PASS are not set');
  }
  // Fail closed on unreadable packs: missing terms would sanitize incompletely.
  let packs = NO_PACKS;
  try {
    packs = await hookPacks(packFlag);
  } catch {
    if (packsConfigured(packFlag)) return withhold('term packs unreadable ($CLOAK_PACKS / --pack)');
  }
  try {
    // Key-cached session load: PBKDF2 runs once per session, not twice per tool call.
    const { mapping: prior, crypto: sc } = await loadSessionMapping(session.path, session.pass);
    let mapping = prior;
    const { updated, found } = transformResponseText(resp, (s) => {
      const r = engine.sanitize(s, {
        priorMapping: mapping,
        customTerms: packs.customTerms,
        whitelist: packs.whitelist,
      });
      mapping = r.mapping; // accumulate across stdout/stderr/content fields
      return r.sanitized;
    });
    if (!found) return null;
    await saveSessionMapping(session.path, sc, mapping);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
  } catch {
    return withhold('sanitization failed (wrong $CLOAK_PASS or corrupt session bridge?)');
  }
}

/**
 * PreToolUse restore: the model has been working over decoys, so a Write/Edit it
 * produces contains decoys. Re-inflate them to real values before the write hits
 * disk. Fail-CLOSED: if restore can't run, DENY the write rather than persist
 * decoy data into a real file.
 */
/** tool_input fields the restore hook re-inflates (Write/Edit text + Bash commands). */
const RESTORE_FIELDS = ['content', 'new_string', 'old_string', 'command'] as const;

export async function hookRestore(evt: HookEvent): Promise<HookResponse> {
  const input = evt.tool_input ?? {};
  const hasText = RESTORE_FIELDS.some((k) => typeof input[k] === 'string');
  if (!hasText) return null;

  // Fail-CLOSED: if this hook is wired up but we can't restore, DENY the tool
  // call rather than let decoy values reach a real file or a real command.
  const deny = (why: string): HookResponse => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Cloakroom: blocked this tool call rather than act on decoy values — ${why}. ` +
        'Check $CLOAK_SESSION_BRIDGE / $CLOAK_PASS.',
    },
  });

  const session = sessionBridge();
  if (!session) return deny('transparent mode is installed but the session env is not set');
  try {
    const { mapping } = await loadSessionMapping(session.path, session.pass);
    const updated: Record<string, unknown> = { ...input };
    for (const k of RESTORE_FIELDS) {
      if (typeof input[k] === 'string') updated[k] = engine.desanitize(input[k] as string, mapping);
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } };
  } catch {
    return deny('restore failed (wrong $CLOAK_PASS or corrupt session bridge?)');
  }
}
