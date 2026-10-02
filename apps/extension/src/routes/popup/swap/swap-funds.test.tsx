import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitLoHi } from '@penumbrafi/types/lo-hi';

const worker = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../../state/keyring/network-worker', async orig => ({
  ...(await orig<object>()),
  buildSendTxInWorker: worker.build,
}));

import { buildDeposit, RefundedSlot, STEP_FOR } from './crosschain';
import { traceOut, u128 } from './penumbra-units';
import { maxSendable, quoteSend } from '../send/spendable';
import { nodeStatus } from '../../../state/swap/thornode';

describe('a swap deposit spends the chosen pocket', () => {
  const base = { walletId: 'vault', zidecarUrl: 'https://z', to: 't1dep', amountIn: '0.1' };

  it('sends a zigner build to the chosen store and account, unsigned', async () => {
    worker.build.mockResolvedValue({ sighash: '00' });
    await buildDeposit({ ...base, storeId: 'vault#2', pocket: 2, ufvk: 'uview1x' });
    expect(worker.build).toHaveBeenLastCalledWith(
      'zcash',
      'vault#2',
      'https://z',
      't1dep',
      '10000000',
      '',
      2,
      true,
      undefined,
      'uview1x',
    );
  });

  it('falls back to the wallet store only when there is no pocket store', async () => {
    await buildDeposit({ ...base, pocket: 3, ufvk: 'uview1x' });
    const args = worker.build.mock.lastCall!;
    expect([args[1], args[6]]).toEqual(['vault', 3]);
  });

  it('sends a hot build with the vault and no ufvk', async () => {
    const vault = { id: 'v' } as never;
    await buildDeposit({ ...base, storeId: 'vault#1', pocket: 1, vault });
    const args = worker.build.mock.lastCall!;
    expect([args[1], args[6], args[8], args[9]]).toEqual(['vault#1', 1, vault, undefined]);
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
