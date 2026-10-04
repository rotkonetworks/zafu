import { describe, expect, it } from 'vitest';
import { Key } from '@repo/encryption/key';
import { resealSnapshot } from '../../state/keyring/reseal';
import { fakeSealer, memoryArea } from './fakes.test-util';
import { LEDGER_OPERATIONS_KEY, createLedgerOperationStore } from './operations-store';
import { keySealer } from './sealing';

const op = {
  operationId: 'send:w1:1',
  walletId: 'w1',
  network: 'main' as const,
  kind: 'send' as const,
  signedTxHex: '050000800a27a726abcdef',
  txid: 'aa',
  coldSendId: 'cold-1',
};

describe('ledger operations store', () => {
  it('seals the signed bytes at rest; metadata stays listable', async () => {
    const area = memoryArea();
    const store = createLedgerOperationStore({ area, sealer: fakeSealer() });
    await store.checkpoint(op);
    const raw = JSON.stringify(area.data.get(LEDGER_OPERATIONS_KEY));
    expect(raw).not.toContain(op.signedTxHex);
    expect(raw).not.toContain('cold-1');
    expect((await store.list())[0]).toMatchObject({ state: 'signed', txid: 'aa' });
    expect(await store.get(op.operationId)).toMatchObject({
      signedTxHex: op.signedTxHex,
      coldSendId: 'cold-1',
    });
  });

  it('transitions are compare-and-set; acknowledge only a broadcast result', async () => {
    const store = createLedgerOperationStore({ area: memoryArea(), sealer: fakeSealer() });
    await store.checkpoint(op);
    await expect(store.acknowledge(op.operationId)).rejects.toMatchObject({ code: 'wrong_state' });
    await store.transition(op.operationId, ['signed'], 'broadcast_uncertain');
    await expect(store.transition(op.operationId, ['signed'], 'broadcast')).rejects.toMatchObject({
      code: 'wrong_state',
    });
    await store.transition(op.operationId, ['broadcast_uncertain'], 'broadcast');
    await store.acknowledge(op.operationId);
    expect(await store.list()).toEqual([]);
  });

  it('a password change re-seals pending checkpoints with the vaults', async () => {
    const from = (await Key.create('old')).key;
    const to = (await Key.create('new')).key;
    const area = memoryArea();
    await createLedgerOperationStore({ area, sealer: keySealer(from) }).checkpoint(op);
    // the keyring's rekey walks all of local storage; the checkpoint is in it
    const patch = await resealSnapshot(Object.fromEntries(area.data), from, to);
    await area.set(LEDGER_OPERATIONS_KEY, patch[LEDGER_OPERATIONS_KEY]);
    const after = createLedgerOperationStore({ area, sealer: keySealer(to) });
    expect((await after.get(op.operationId))?.signedTxHex).toBe(op.signedTxHex);
    const stale = createLedgerOperationStore({ area, sealer: keySealer(from) });
    await expect(stale.get(op.operationId)).rejects.toMatchObject({ code: 'undecryptable' });
  });
});
