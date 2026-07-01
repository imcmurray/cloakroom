// Session key cache for the Claude Code hooks.
//
// The hooks run as a fresh process on EVERY tool call, and the bridge's
// passphrase→key derivation is deliberately expensive (PBKDF2, 600k
// iterations). Without a cache each hook call pays that twice (decrypt +
// re-encrypt) — roughly a second of added latency per Read/Bash. So the first
// hook call derives once and stores the RAW derived key in `<bridge>.key`
// (mode 0600) next to the session bridge; later calls import it in ~1ms.
//
// Security trade-off, stated plainly: the keyfile lets anyone who can read it
// decrypt the session bridge without the passphrase. For the HOOK use-case
// this adds ~zero marginal risk — the same user already has $CLOAK_PASS in the
// process environment and can read the original files being sanitized. The
// interactive CLI commands (sanitize/restore/inspect) never create keyfiles;
// exported bridges you share remain passphrase-only. Delete the .key file (or
// the whole .cloak/ dir) when the session ends.

import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import {
  decryptBridgeWithKey,
  deriveBridgeKey,
  encryptBridgeWithKey,
  exportBridgeKey,
  importBridgeKey,
  readBridgeSalt,
  type MappingEntry,
} from '../core/index';

export interface SessionCrypto {
  key: CryptoKey;
  salt: Uint8Array;
}

const cachePathFor = (bridgePath: string): string => bridgePath + '.key';

async function deriveAndCache(bridgePath: string, pass: string): Promise<SessionCrypto> {
  // Reuse the existing bridge's salt so the derived key can decrypt it.
  const salt = existsSync(bridgePath)
    ? readBridgeSalt(await readFile(bridgePath, 'utf8'))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBridgeKey(pass, salt, true);
  await writeFile(
    cachePathFor(bridgePath),
    JSON.stringify({ v: 1, salt: Buffer.from(salt).toString('base64'), key: await exportBridgeKey(key) }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { key, salt };
}

async function cachedCrypto(bridgePath: string): Promise<SessionCrypto | null> {
  const cachePath = cachePathFor(bridgePath);
  if (!existsSync(cachePath)) return null;
  try {
    const c = JSON.parse(await readFile(cachePath, 'utf8')) as { salt: string; key: string };
    return { key: await importBridgeKey(c.key), salt: new Uint8Array(Buffer.from(c.salt, 'base64')) };
  } catch {
    return null; // corrupt cache → caller re-derives
  }
}

/**
 * Load the session mapping using the key cache, deriving (once) on a cold
 * start. If a cached key fails to decrypt the bridge (stale cache — e.g. the
 * bridge was recreated under a different passphrase), the cache is discarded
 * and one full re-derive is attempted before giving up.
 */
export async function loadSessionMapping(
  bridgePath: string,
  pass: string,
): Promise<{ mapping: MappingEntry[]; crypto: SessionCrypto }> {
  let sc = (await cachedCrypto(bridgePath)) ?? (await deriveAndCache(bridgePath, pass));
  if (!existsSync(bridgePath)) return { mapping: [], crypto: sc };

  const blob = await readFile(bridgePath, 'utf8');
  try {
    return { mapping: (await decryptBridgeWithKey(blob, sc.key)).mapping, crypto: sc };
  } catch {
    // Stale cache? Re-derive from the passphrase against the blob's own salt.
    await unlink(cachePathFor(bridgePath)).catch(() => {});
    sc = await deriveAndCache(bridgePath, pass);
    return { mapping: (await decryptBridgeWithKey(blob, sc.key)).mapping, crypto: sc };
  }
}

/** Re-encrypt and persist the session mapping with the (cached) session key. */
export async function saveSessionMapping(
  bridgePath: string,
  sc: SessionCrypto,
  mapping: MappingEntry[],
): Promise<void> {
  const blob = await encryptBridgeWithKey(mapping, sc.key, sc.salt, 'realistic');
  await writeFile(bridgePath, blob, { encoding: 'utf8', mode: 0o600 });
}
