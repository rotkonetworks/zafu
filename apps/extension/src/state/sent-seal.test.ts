import { beforeEach, describe, expect, test } from 'vitest';
import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { reconcileSentTxs, type SentTxRecord } from '../workers/sent-tx-reconcile';
import { isEncryptedWrapper, markHydrated } from './encrypted-storage';
import { resealSnapshot } from './keyring/reseal';
import { isPlain, openSent, openSentRows, sealSent, sentKey } from './sent-seal';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

/** a record as an older version wrote it: everything in the clear */
const old: SentTxRecord = {
  walletId: 'w1',
  txid: 'tx1',
  amount: '50000',
  fee: '10000',
  recipient: 'u1alice',
  pool: 'orchard',
  kind: 'send',
  memo: 'rent for march',
  payments: [
    { recipient: 'u1alice', amount: '40000', memo: 'rent for march' },
    { recipient: 'u1bob', amount: '10000' },
  ],
  sentAt: 1,
  expiryHeight: 100,
};

const unlock = async (key?: Key) => {
  const k = key ?? (await Key.create('pw')).key;
  await sessionExtStorage.set('passwordKey', await k.toJson());
  return k;
};

describe('sent records at rest', () => {
  beforeEach(async () => {
    localMock.clear();
    await chrome.storage.session.clear();
    await localExtStorage.remove('sentKey' as never);
    markHydrated();
  });

  test('sealing takes recipient, memo and payments out, and keeps what the worker needs', async () => {
    await unlock();
    const key = (await sentKey(true))!;
    const sealed = await sealSent(old, key);
    expect(isPlain(sealed)).toBe(false);
    expect(JSON.stringify(sealed)).not.toMatch(/alice|bob|rent/);
    expect(sealed).toMatchObject({ txid: 'tx1', amount: '50000', fee: '10000', expiryHeight: 100 });
    const { sealed: _, ...opened } = await openSent(sealed, key);
    expect(opened).toEqual(old);
  });

  test('the worker passes the sealed box to the history row, and the row opens', async () => {
    await unlock();
    const sealed = await sealSent(old, (await sentKey(true))!);
    const { txs } = reconcileSentTxs({ chainTxs: [], sent: [sealed], scannedHeight: 10 });
    expect(txs[0]!.recipient).toBeUndefined();
    const [row] = await openSentRows(txs);
    expect(row).toMatchObject({ recipient: 'u1alice', memo: 'rent for march', fee: '10000' });
    expect(row!.payments).toHaveLength(2);
    expect(row).not.toHaveProperty('sealed');
  });

  test('locked, rows stay sealed and no key is made', async () => {
    await unlock();
    const sealed = await sealSent(old, (await sentKey(true))!);
    await chrome.storage.session.clear();
    expect(await sentKey(true)).toBeNull();
    const [row] = await openSentRows([sealed]);
    expect(row!.recipient).toBeUndefined();
    expect(row!.sealed).toBeDefined();
  });

  test('one key, made once and sealed under the password', async () => {
    await unlock();
    const a = (await sentKey(true))!;
    const b = (await sentKey(true))!;
    const box = await a.seal('x');
    expect(await b.unseal(box)).toBe('x');
    expect(isEncryptedWrapper(localMock.get('sentKey'))).toBe(true);
  });

  test('a password change moves the key, so records sealed before still open', async () => {
    const before = await unlock();
    const sealed = await sealSent(old, (await sentKey(true))!);
    const after = (await Key.create('new')).key;
    const patch = await resealSnapshot(Object.fromEntries(localMock), before, after);
    expect(patch).toHaveProperty('sentKey');
    await chrome.storage.local.set(patch);
    await unlock(after);
    const opened = await openSent(sealed, await sentKey(false));
    expect(opened.recipient).toBe('u1alice');
  });

  test('a key that does not open is never replaced', async () => {
    await unlock();
    await sentKey(true);
    const stored = localMock.get('sentKey');
    await unlock(); // another password: the stored key no longer opens
    expect(await sentKey(true)).toBeNull();
    expect(localMock.get('sentKey')).toEqual(stored);
  });
});
