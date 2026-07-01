// Command implementations. Each returns an exit code. All plaintext handling
// delegates to @cloakroom/core (src/core) — the same engine the browser uses.

import {
  engine,
  encryptBridge,
  decryptBridge,
  type AuditItem,
  type EntityType,
  type MappingEntry,
  type SanitizeOptions,
  type CustomTerm,
} from '../core/index';
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

function buildOptions(flags: ParsedArgs['flags']): SanitizeOptions {
  const mode = flags['mode'];
  if (mode !== undefined && mode !== 'realistic' && mode !== 'token') {
    throw new CliError(`--mode must be 'realistic' or 'token', got '${String(mode)}'.`);
  }
  const customTerms: CustomTerm[] | undefined = listFlag(flags['custom'])?.map((value) => ({
    value,
  }));
  return {
    mode: (mode as 'realistic' | 'token' | undefined) ?? 'realistic',
    enabledTypes: listFlag(flags['types']) as EntityType[] | undefined,
    whitelist: listFlag(flags['whitelist']),
    customTerms,
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
  const opts = buildOptions(args.flags);
  const text = await readInput(args.input);
  const merge = args.flags['merge'] === true;

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
  const opts = buildOptions(args.flags);
  const text = await readInput(args.input);
  // Detect-only: reuse the engine but discard the mapping entirely.
  const { audit } = engine.sanitize(text, opts);

  if (args.flags['json']) {
    out(JSON.stringify({ found: audit.length, audit }));
  } else {
    err(renderAudit(audit));
  }
  // Exit 3 on any hit so `cloak scan` composes as a pre-commit / CI guardrail.
  return audit.length > 0 ? 3 : 0;
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

function toolOutputText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const k of ['output', 'stdout', 'content', 'text']) {
      if (typeof r[k] === 'string') return r[k] as string;
    }
  }
  return '';
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
  let response: HookResponse;
  switch (mode) {
    case 'guard':
      response = await hookGuard(evt);
      break;
    case 'sanitize':
      response = await hookSanitize(evt);
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

/**
 * PreToolUse guard: deny reading a file that is full of secrets, so it can't be
 * pulled into context by accident. Fail-open (allow) on any error — this is a
 * bonus safety net, not the primary control.
 */
export async function hookGuard(evt: HookEvent): Promise<HookResponse> {
  try {
    const file = evt.tool_input?.['file_path'];
    if (typeof file !== 'string' || !existsSync(file)) return null;
    const text = await readFile(file, 'utf8');
    const { audit } = engine.sanitize(text);
    if (audit.length === 0) return null;
    const types = [...new Set(audit.map((a) => a.type))].join(', ');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Cloakroom: ${file} contains ${audit.length} PII/secret value(s) (${types}). ` +
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
export async function hookSanitize(evt: HookEvent): Promise<HookResponse> {
  const text = toolOutputText(evt.tool_result);
  if (!text) return null;
  const session = sessionBridge();
  if (!session) return null; // not configured for transparent mode → leave untouched
  try {
    const prior = existsSync(session.path) ? await loadMapping(session.path, session.pass) : undefined;
    const result = engine.sanitize(text, { priorMapping: prior });
    const blob = await encryptBridge(result.mapping, session.pass, 'realistic');
    await writeBridge(session.path, blob);
    return {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: result.sanitized },
    };
  } catch {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput:
          '[cloak: could not sanitize this output, so it was withheld from context. ' +
          'Check $CLOAK_SESSION_BRIDGE / $CLOAK_PASS.]',
      },
    };
  }
}

/**
 * PreToolUse restore: the model has been working over decoys, so a Write/Edit it
 * produces contains decoys. Re-inflate them to real values before the write hits
 * disk. Fail-CLOSED: if restore can't run, DENY the write rather than persist
 * decoy data into a real file.
 */
export async function hookRestore(evt: HookEvent): Promise<HookResponse> {
  const session = sessionBridge();
  const input = evt.tool_input ?? {};
  const hasText = ['content', 'new_string', 'old_string'].some((k) => typeof input[k] === 'string');
  if (!hasText || !session) return null;
  try {
    const mapping = existsSync(session.path) ? await loadMapping(session.path, session.pass) : [];
    const updated: Record<string, unknown> = { ...input };
    for (const k of ['content', 'new_string', 'old_string']) {
      if (typeof input[k] === 'string') updated[k] = engine.desanitize(input[k] as string, mapping);
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } };
  } catch {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Cloakroom: could not restore real values before writing, so the write was blocked ' +
          'to avoid persisting decoy data. Check $CLOAK_SESSION_BRIDGE / $CLOAK_PASS.',
      },
    };
  }
}
