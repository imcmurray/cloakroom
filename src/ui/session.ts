// Encrypted session-restore for the browser app.
//
// The threat model's terms (docs/THREAT-MODEL.md, mitigation 2): persistence
// is OPT-IN, always encrypted at rest, with panic-clear and auto-expiry.
// Concretely:
//  - The user enables saving with a passphrase. The AES key is derived once
//    (PBKDF2 600k, same as bridge files) and held ONLY in memory — reloading
//    the page always requires the passphrase again.
//  - Snapshots (tabs, vocabulary, mappings) are AES-256-GCM encrypted before
//    they touch localStorage. Plaintext metadata is limited to: saved-at
//    timestamp and tab count (needed for the unlock banner and expiry).
//  - Saved sessions expire after SESSION_TTL_DAYS and are deleted on sight.
//  - "Forget" deletes the stored blob immediately (panic clear).
//
// DOM-free (storage is injected) so all of it unit-tests in node.

import {
  decryptJsonWithKey,
  deriveBridgeKey,
  encryptJsonWithKey,
  readBridgeSalt,
  type MappingEntry,
  type SanitizeResult,
} from '../core/index';

export const SESSION_KEY = 'cloakroom.session.v1';
export const SESSION_TTL_DAYS = 7;

/** Everything one tab needs to come back exactly as it was left. */
export interface DocSnapshot {
  original: string;
  aiResponse: string;
  result: SanitizeResult | null;
  outboundOpen: boolean;
  inboundOpen: boolean;
  imported: boolean;
}

/** The encrypted payload: the whole workspace. */
export interface SessionPayload {
  v: 1;
  mode: 'realistic' | 'token';
  terms: string;
  whitelist: string;
  activeIndex: number;
  docs: DocSnapshot[];
}

/** The stored envelope: plaintext metadata + the encrypted payload blob. */
interface StoredSession {
  v: 1;
  savedAt: string;
  tabCount: number;
  blob: string;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface SessionKeyPair {
  key: CryptoKey;
  salt: Uint8Array;
}

/** Derive a fresh session key from a passphrase (enable flow). */
export async function newSessionKey(passphrase: string): Promise<SessionKeyPair> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveBridgeKey(passphrase, salt), salt };
}

/** Encrypt and store a snapshot. */
export async function saveSession(
  storage: StorageLike,
  kp: SessionKeyPair,
  payload: SessionPayload,
): Promise<void> {
  const blob = await encryptJsonWithKey(payload, kp.key, kp.salt);
  const stored: StoredSession = {
    v: 1,
    savedAt: new Date().toISOString(),
    tabCount: payload.docs.length,
    blob,
  };
  storage.setItem(SESSION_KEY, JSON.stringify(stored));
}

export type PeekResult =
  | { state: 'none' }
  | { state: 'expired'; savedAt: string }
  | { state: 'present'; savedAt: string; tabCount: number };

/** What's in storage? Deletes expired sessions on sight. */
export function peekSession(storage: StorageLike, now: Date = new Date()): PeekResult {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return { state: 'none' };
  try {
    const stored = JSON.parse(raw) as StoredSession;
    const age = now.getTime() - new Date(stored.savedAt).getTime();
    if (!Number.isFinite(age) || age > SESSION_TTL_DAYS * 86_400_000 || age < 0) {
      storage.removeItem(SESSION_KEY);
      return { state: 'expired', savedAt: stored.savedAt };
    }
    return { state: 'present', savedAt: stored.savedAt, tabCount: stored.tabCount };
  } catch {
    storage.removeItem(SESSION_KEY); // unreadable → treat as gone
    return { state: 'none' };
  }
}

/** Decrypt the stored session; returns the payload plus a key pair for future
 *  saves (re-derived from the blob's own salt). Throws on wrong passphrase. */
export async function unlockSession(
  storage: StorageLike,
  passphrase: string,
): Promise<{ payload: SessionPayload; kp: SessionKeyPair }> {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) throw new Error('no saved session');
  const stored = JSON.parse(raw) as StoredSession;
  const salt = readBridgeSalt(stored.blob);
  const key = await deriveBridgeKey(passphrase, salt);
  const payload = await decryptJsonWithKey<SessionPayload>(stored.blob, key);
  return { payload, kp: { key, salt } };
}

/** Panic clear. */
export function forgetSession(storage: StorageLike): void {
  storage.removeItem(SESSION_KEY);
}

/** Never persist an empty workspace over a real one by accident. */
export function isWorthSaving(payload: SessionPayload): boolean {
  return payload.docs.some((d) => d.original.trim() !== '' || (d.result?.mapping.length ?? 0) > 0);
}
