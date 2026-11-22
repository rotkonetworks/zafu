import { beforeEach, describe, expect, it } from 'vitest';
import { Key } from '@repo/encryption/key';
import { storage } from '@repo/mock-chrome';
import { isEncryptedWrapper } from '../state/encrypted-storage';
import {
  clearNetEgressLog,
  exportEgressChoices,
  importEgressChoices,
  readNetEgress,
  readNetEgressLog,
  recordRefusal,
  sealNetEgressLog,
  setDestinationDecision,
  setDestinationOptIn,
} from './ledger';
import { compileEgress, NYM_KEEP_READY, nymGroupKey } from './egress-policy';
import { NYM } from './nym-bridge';

describe('egress choices in the personal-data backup', () => {
  it('round-trips the user decisions and nothing else', async () => {
    await setDestinationDecision('blocked.example', 'blocked');
    await setDestinationDecision('allowed.example', 'allowed');
    await setDestinationDecision('asked.example', 'pending');
    await setDestinationOptIn('zcash-me', 'allowed');
    await setDestinationOptIn('near-swap', 'blocked');
    await setDestinationOptIn('thorname', 'allowed');

    const backup = await exportEgressChoices();
    expect(backup.hosts).toMatchObject({
      'blocked.example': 'blocked',
      'allowed.example': 'allowed',
    });
    expect(backup.hosts['asked.example']).toBeUndefined();
    expect(backup.optIns).toMatchObject({
      'zcash-me': 'allowed',
      'near-swap': 'blocked',
      thorname: 'allowed',
    });

    await chrome.storage.local.remove('netEgress');
    await importEgressChoices(JSON.parse(JSON.stringify(backup)) as typeof backup);
    const restored = await readNetEgress();
    expect(restored.destinations['blocked.example']?.state).toBe('blocked');
    expect(restored.destinations['allowed.example']?.state).toBe('allowed');
    expect(restored.optIns).toMatchObject({ 'zcash-me': 'allowed', 'near-swap': 'blocked' });
  });

  it('restores nothing from a backup made before the policy, or from junk', async () => {
    const before = await readNetEgress();
    await importEgressChoices(undefined);
    await importEgressChoices({
      hosts: { 'x.example': 'maybe' as never },
      optIns: { y: 'sure' as never },
    });
    const after = await readNetEgress();
    expect(after.destinations['x.example']).toBeUndefined();
    expect(after.optIns['y']).toBeUndefined();
    expect(Object.keys(after.optIns)).toEqual(Object.keys(before.optIns));
  });

  it('carries "send over nym" chosen through a backup and its restore', async () => {
    await setDestinationOptIn(NYM, 'allowed');
    const backup = JSON.parse(JSON.stringify(await exportEgressChoices())) as Awaited<
      ReturnType<typeof exportEgressChoices>
    >;
    // a fresh install: the default, off until chosen
    await setDestinationOptIn(NYM, undefined);
    expect(compileEgress({ netEgress: await readNetEgress() }).nym).toBe(false);
    await importEgressChoices(backup);
    expect(compileEgress({ netEgress: await readNetEgress() }).nym).toBe(true);
    await setDestinationOptIn(NYM, undefined);
  });

  it('carries the per-network nym choice and keep-ready through a backup and its restore', async () => {
    await setDestinationOptIn(nymGroupKey('zcash'), 'blocked');
    await setDestinationOptIn(nymGroupKey('penumbra'), 'allowed');
    await setDestinationOptIn(NYM_KEEP_READY, 'blocked');
    const backup = JSON.parse(JSON.stringify(await exportEgressChoices())) as Awaited<
      ReturnType<typeof exportEgressChoices>
    >;
    await chrome.storage.local.remove('netEgress');
    await importEgressChoices(backup);
    expect((await readNetEgress()).optIns).toMatchObject({
      'nym:zcash': 'blocked',
      'nym:penumbra': 'allowed',
      'nym-ready': 'blocked',
    });
  });
});

describe('the audit trail at rest', () => {
  const unlock = async () =>
    storage.session.set({ passwordKey: await (await Key.create('pw')).key.toJson() });
  const stored = async () => (await chrome.storage.local.get('netEgressLog'))['netEgressLog'];

  beforeEach(async () => {
    await clearNetEgressLog();
    await storage.session.clear();
  });

  it('is sealed, and reads back only while unlocked', async () => {
    await unlock();
    await recordRefusal({ host: 'one.example', reason: 'blocked' } as never);
    expect(isEncryptedWrapper(await stored())).toBe(true);
    expect(JSON.stringify(await stored())).not.toContain('one.example');
    expect((await readNetEgressLog()).map(l => l.host)).toEqual(['one.example']);
    await storage.session.clear();
    expect(await readNetEgressLog()).toEqual([]);
  });

  it('keeps a line that came while locked, and seals it on unlock', async () => {
    await recordRefusal({ host: 'locked.example', reason: 'blocked' } as never);
    expect(await stored()).toBeUndefined();
    await unlock();
    // what the passwordKey listener runs (the mock storage fires no change events)
    await sealNetEgressLog();
    expect(isEncryptedWrapper(await stored())).toBe(true);
    expect((await readNetEgressLog()).map(l => l.host)).toEqual(['locked.example']);
  });

  it('seals a plain trail an older version wrote, keeping its lines', async () => {
    const old = [{ ts: 1, host: 'old.example', purpose: 'other', outcome: 'blocked' }];
    await chrome.storage.local.set({ netEgressLog: old });
    await sealNetEgressLog();
    expect(await stored()).toEqual(old);
    await unlock();
    await sealNetEgressLog();
    expect(isEncryptedWrapper(await stored())).toBe(true);
    expect((await readNetEgressLog()).map(l => l.host)).toEqual(['old.example']);
  });
});
