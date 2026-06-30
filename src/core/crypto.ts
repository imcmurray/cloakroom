// Client-side bridge-file encryption using the Web Crypto API.
// Works in browsers, Web Workers, and Node 20+ (globalThis.crypto.subtle).
//
// The "bridge file" is the only artifact that ever contains the real mapping,
// and it is AES-256-GCM encrypted with a key derived from a user passphrase via
// PBKDF2 (600k iterations). The server never sees the passphrase or the plaintext.

import type { BridgeFile, MappingEntry } from './types';

const PBKDF2_ITERS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copy any typed array into a fresh ArrayBuffer — a clean BufferSource for Web Crypto across TS lib versions. */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', ab(enc.encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ab(salt), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a mapping into a portable, password-protected string. */
export async function encryptBridge(
  mapping: MappingEntry[],
  passphrase: string,
  mode: 'realistic' | 'token' = 'realistic',
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const payload: BridgeFile = { v: 1, createdAt: new Date().toISOString(), mode, mapping };
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(enc.encode(JSON.stringify(payload)))),
  );
  return JSON.stringify({
    v: 1,
    kdf: { name: 'PBKDF2', iters: PBKDF2_ITERS, hash: 'SHA-256' },
    salt: b64encode(salt),
    iv: b64encode(iv),
    ct: b64encode(ct),
  });
}

/** Decrypt a bridge file back into a mapping. Throws on wrong passphrase (GCM auth fail). */
export async function decryptBridge(blob: string, passphrase: string): Promise<BridgeFile> {
  const parsed = JSON.parse(blob);
  const salt = b64decode(parsed.salt);
  const iv = b64decode(parsed.iv);
  const ct = b64decode(parsed.ct);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(ct));
  return JSON.parse(dec.decode(pt)) as BridgeFile;
}
