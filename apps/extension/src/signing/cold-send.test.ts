import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The airgap FROST completion through the shared cold tail.
 *
 * The worker cannot load in a unit test (see workers/cold-send-bookkeeping
 * .test.ts), so this models its `complete-orchard-pczt` contract, which that
 * file pins against the real source: the build stashes its inputs under a
 * per-store send id; the completion broadcasts, throws on a rejected
 * broadcast, and only then takes the stash BY ID and marks those inputs spent.
 */
const worker = vi.hoisted(() => {
  const stash = new Map<string, string[]>(); // `${store}/${id}` -> nullifiers
  const spent = new Set<string>();
  let broadcastOk = true;
  return {
    stash,
    spent,
    setBroadcast: (ok: boolean) => {
      broadcastOk = ok;
    },
    completeOrchardPcztInWorker: vi.fn(
      async (
        walletId: string,
        _url: string,
        _pczt: string,
        _sigs: string[],
        _idx: number[],
        coldSendId?: string,
      ) => {
        if (!broadcastOk) {
          throw new Error('broadcast failed (18): bad-txns');
        }
        const key = `${walletId}/${coldSendId}`;
        for (const n of (coldSendId && stash.get(key)) || []) {
          spent.add(n);
        }
        stash.delete(key);
        return { txid: 'ab'.repeat(32) };
      },
    ),
    completeSendTxPcztInWorker: vi.fn(),
  };
});

vi.mock('../state/keyring/network-worker', () => worker);
vi.mock('../routes/popup/send/frost-multisig', () => ({ runMnemonicFrostSign: vi.fn() }));

import { signAndBroadcast } from './cold-send';
import { frostAirgapSigner } from './frost-signer';

const STORE = 'wallet-1#1'; // a pocket store, not the bare wallet id
const unsigned = { pcztHex: 'pczt', spendIndices: [0, 2], coldSendId: 'send-7' };
const sigs = ['s0', 's2'];
const deps = { walletId: STORE, zidecarUrl: 'https://z', mainnet: true };

const complete = () => signAndBroadcast(frostAirgapSigner(sigs, unsigned), unsigned, deps);

beforeEach(() => {
  worker.stash.clear();
  worker.spent.clear();
  worker.setBroadcast(true);
  worker.completeOrchardPcztInWorker.mockClear();
  worker.stash.set(`${STORE}/send-7`, ['nf-a', 'nf-b']);
});

describe('airgap FROST completion', () => {
  it('marks the inputs spent after a successful broadcast', async () => {
    const { txid } = await complete();
    expect(txid).toHaveLength(64);
    expect([...worker.spent]).toEqual(['nf-a', 'nf-b']);
    expect(worker.completeOrchardPcztInWorker).toHaveBeenCalledWith(
      STORE,
      'https://z',
      'pczt',
      sigs,
      [0, 2],
      'send-7',
    );
  });

  it('does not mark the inputs spent when the broadcast fails', async () => {
    worker.setBroadcast(false);
    await expect(complete()).rejects.toThrow('broadcast failed');
    expect(worker.spent.size).toBe(0);
    // the stash survives for a retry or the block scan
    expect(worker.stash.has(`${STORE}/send-7`)).toBe(true);
  });

  it('the old call (no send id, bare wallet id) marked nothing', async () => {
    // what handleAirgapComplete used to do
    await worker.completeOrchardPcztInWorker('wallet-1', 'https://z', 'pczt', sigs, [0, 2]);
    expect(worker.spent.size).toBe(0);
  });
});
