import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitLoHi } from '@penumbrafi/types/lo-hi';

const worker = vi.hoisted(() => ({ build: vi.fn(), pczt: vi.fn(), complete: vi.fn() }));
vi.mock('../../../state/keyring/network-worker', async orig => ({
  ...(await orig<object>()),
  buildSendTxInWorker: worker.build,
  buildSendTxPcztInWorker: worker.pczt,
  completeSendTxPcztInWorker: worker.complete,
}));

import { buildDeposit, payDepositViaZigner, RefundedSlot, STEP_FOR } from './crosschain';
import type { ZignerRound } from '../../../signing/zigner-round';
import { MOVE_NEEDS_MS, tooLateToMove } from '../../../state/swap/thor-out';
import { traceOut, u128 } from './penumbra-units';
import { maxSendable, quoteSend } from '../send/spendable';
import { nodeStatus } from '../../../state/swap/thornode';

describe('a swap deposit spends the chosen pocket', () => {
  const base = { walletId: 'vault', zidecarUrl: 'https://z', to: 't1dep', amountIn: '0.1' };

  // zigner pays through the PCZT round, never the legacy bare-sighash request
  const built = { pcztHex: 'aa', urFrames: ['ur:zigner-module/1-1/x'], coldSendId: 'c1' };
  const signedRound = (signed: string) =>
    ({ sign: vi.fn().mockResolvedValue(signed) }) as unknown as ZignerRound;
  const cold = { ...base, mainnet: true, ufvk: 'uview1x' };

  it('builds a zigner deposit as a PCZT from the paying store, then broadcasts it', async () => {
    worker.pczt.mockResolvedValue(built);
    worker.complete.mockResolvedValue({ txid: 'tx1' });
    const round = signedRound('signed-pczt');
    const order: string[] = [];
    const txid = await payDepositViaZigner(round, { ...cold, storeId: 'vault#2' }, async () => {
      order.push('recorded');
    });
    expect(txid).toBe('tx1');
    expect(worker.pczt).toHaveBeenLastCalledWith(
      'zcash',
      'vault#2',
      'https://z',
      't1dep',
      '10000000',
      '',
      0,
      true,
      'uview1x',
      false,
      undefined,
      undefined,
      true,
    );
    expect(round.sign).toHaveBeenCalledWith(built, 'deposit 0.1 zec to the swap');
    expect(worker.complete).toHaveBeenLastCalledWith(
      'zcash',
      'vault#2',
      'https://z',
      'signed-pczt',
      'c1',
    );
    expect(order).toEqual(['recorded']);
  });

  it('a zigner deposit falls back to the wallet store, and follows the wallet network', async () => {
    worker.pczt.mockResolvedValue(built);
    worker.complete.mockResolvedValue({ txid: 'tx2' });
    await payDepositViaZigner(signedRound('s'), { ...cold, mainnet: false }, async () => {});
    const args = worker.pczt.mock.lastCall!;
    expect([args[1], args[7]]).toEqual(['vault', false]);
  });

  it('nothing is recorded or broadcast when zigner is declined', async () => {
    worker.pczt.mockResolvedValue(built);
    worker.complete.mockClear();
    const round = {
      sign: vi.fn().mockRejectedValue(new Error('declined')),
    } as unknown as ZignerRound;
    const recorded = vi.fn();
    await expect(payDepositViaZigner(round, cold, recorded)).rejects.toThrow('declined');
    expect(recorded).not.toHaveBeenCalled();
    expect(worker.complete).not.toHaveBeenCalled();
  });

  it('sends a hot build with the vault and no ufvk', async () => {
    const vault = { id: 'v' } as never;
    await buildDeposit({ ...base, storeId: 'vault#1', pocket: 1, vault });
    const args = worker.build.mock.lastCall!;
    expect([args[1], args[6], args[8]]).toEqual(['vault#1', 1, vault]);
    expect(args).toHaveLength(9);
  });
});

describe('max is what quoteSend can build', () => {
  it('max sends, one zat more does not', () => {
    const notes = [50_000_000n, 7_000n, 1_230_000n];
    const { amountZat } = maxSendable(notes, { transparentRecipient: true });
    expect(quoteSend(notes, amountZat, { transparentRecipient: true }).ok).toBe(true);
    expect(quoteSend(notes, amountZat + 1n, { transparentRecipient: true }).ok).toBe(false);
  });
});

describe('penumbra u128 amounts', () => {
  const big = (1n << 64n) * 3n + 5n;

  it('joins lo and hi, never dropping hi', () => {
    expect(u128(splitLoHi(big))).toBe(big);
    expect(u128({ lo: 7n })).toBe(7n);
    expect(u128(undefined)).toBe(0n);
  });

  it('sums the last value of every trace exactly', () => {
    const trace = (...amounts: bigint[]) => ({
      value: amounts.map(a => ({ amount: splitLoHi(a) })),
    });
    expect(traceOut([trace(1n, big), trace(9n, 10n ** 20n), { value: [] }])).toBe(big + 10n ** 20n);
    expect(traceOut()).toBe(0n);
  });
});

describe('a refund is a calm end', () => {
  it('goes to its own step, never the error step', () => {
    expect(STEP_FOR.refunded).toBe('refunded');
    expect(STEP_FOR.failed).toBe('error');
  });

  it('renders as info, with nothing that invites a second swap', () => {
    const line = nodeStatus(
      {
        stages: { inbound_observed: { completed: true }, inbound_finalised: { completed: true } },
        out_txs: [{ memo: 'REFUND:AB' }],
      },
      'thorchain',
    ).line;
    const html = renderToStaticMarkup(<RefundedSlot line={line} />);
    expect(html).toContain('bg-surface-elev-2/40');
    expect(html).not.toContain('hanko');
    expect(html).not.toMatch(/try again|swap again/);
    expect(html).toContain('it is safe');
  });
});

describe('a thorchain price must outlast the move out of the shielded pool', () => {
  it('asks again before moving when too little of the price is left', () => {
    const now = 1_000_000;
    expect(tooLateToMove(undefined, now)).toBe(false);
    expect(tooLateToMove(now + MOVE_NEEDS_MS, now)).toBe(false);
    expect(tooLateToMove(now + MOVE_NEEDS_MS - 1, now)).toBe(true);
    expect(tooLateToMove(now - 1, now)).toBe(true);
  });
});
