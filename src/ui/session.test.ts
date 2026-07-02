import { describe, it, expect } from 'vitest';
import {
  SESSION_KEY, newSessionKey, saveSession, peekSession, unlockSession, forgetSession,
  isWorthSaving, type SessionPayload, type StorageLike,
} from './session';

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const PAYLOAD: SessionPayload = {
  v: 1,
  mode: 'realistic',
  terms: 'Judge Kwan | PERSON',
  whitelist: '127.0.0.1',
  activeIndex: 1,
  docs: [
    {
      original: 'login from 10.1.2.3', aiResponse: '', result: {
        sanitized: 'login from 192.0.2.7',
        mapping: [{ type: 'IPV4', original: '10.1.2.3', placeholder: '192.0.2.7', count: 1 }],
        audit: [],
      }, outboundOpen: true, inboundOpen: false, imported: false,
    },
    { original: 'second doc', aiResponse: 'a reply', result: null, outboundOpen: true, inboundOpen: true, imported: false },
  ],
};

describe('encrypted session restore', () => {
  it('round-trips: save → peek → unlock with the right passphrase', async () => {
    const storage = memStorage();
    const kp = await newSessionKey('open sesame');
    await saveSession(storage, kp, PAYLOAD);

    const peek = peekSession(storage);
    expect(peek).toMatchObject({ state: 'present', tabCount: 2 });

    const { payload, kp: kp2 } = await unlockSession(storage, 'open sesame');
    expect(payload).toEqual(PAYLOAD);
    // the re-derived key keeps working for subsequent saves
    await saveSession(storage, kp2, { ...PAYLOAD, terms: 'changed' });
    expect((await unlockSession(storage, 'open sesame')).payload.terms).toBe('changed');
  });

  it('secrets are NOT in localStorage plaintext; only savedAt/tabCount are', async () => {
    const storage = memStorage();
    await saveSession(storage, await newSessionKey('pw'), PAYLOAD);
    const raw = storage.map.get(SESSION_KEY)!;
    expect(raw).not.toContain('10.1.2.3');
    expect(raw).not.toContain('Judge Kwan');
    const stored = JSON.parse(raw);
    expect(Object.keys(stored).sort()).toEqual(['blob', 'savedAt', 'tabCount', 'v']);
  });

  it('wrong passphrase throws (GCM auth), session stays intact', async () => {
    const storage = memStorage();
    await saveSession(storage, await newSessionKey('right'), PAYLOAD);
    await expect(unlockSession(storage, 'wrong')).rejects.toThrow();
    expect(peekSession(storage).state).toBe('present');
  });

  it('expires after the TTL and deletes on sight; forget() is immediate', async () => {
    const storage = memStorage();
    await saveSession(storage, await newSessionKey('pw'), PAYLOAD);
    const eightDays = new Date(Date.now() + 8 * 86_400_000);
    expect(peekSession(storage, eightDays).state).toBe('expired');
    expect(storage.map.has(SESSION_KEY)).toBe(false); // deleted on sight

    await saveSession(storage, await newSessionKey('pw'), PAYLOAD);
    forgetSession(storage);
    expect(peekSession(storage).state).toBe('none');
  });

  it('unreadable stored data is discarded, not fatal', () => {
    const storage = memStorage();
    storage.setItem(SESSION_KEY, '{corrupt');
    expect(peekSession(storage).state).toBe('none');
    expect(storage.map.has(SESSION_KEY)).toBe(false);
  });

  it('isWorthSaving rejects an all-empty workspace', () => {
    expect(isWorthSaving({ ...PAYLOAD, docs: [{ original: ' ', aiResponse: '', result: null, outboundOpen: true, inboundOpen: false, imported: false }] })).toBe(false);
    expect(isWorthSaving(PAYLOAD)).toBe(true);
  });
});
