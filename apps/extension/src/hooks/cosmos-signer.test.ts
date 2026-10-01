import { describe, expect, it, vi } from 'vitest';

// the hooks module reads the store; the functions under test take the selected
// key and getMnemonic as arguments, so the store is never consulted
vi.mock('../state', () => ({ useStore: vi.fn() }));
const conduitFor = vi.hoisted(() => vi.fn());
vi.mock('@repo/wallet/networks/transparent/conduit', () => ({ conduitFor }));

import { cosmosIbcTransfer, cosmosSend } from './cosmos-signer';

const REFUSAL = 'this wallet has no key for noble · add one or pick a wallet that has it';

// founder decision: when the selected wallet has no key for the chain, refuse.
// The old findCosmosKey went on to sign with any other phrase wallet it found.
describe('cosmos signing uses the selected wallet only', () => {
  const zignerWithoutCosmos = {
    id: 'z',
    type: 'zigner-zafu',
    insensitive: { coldSignerType: 'zigner' },
  };

  it('refuses a send instead of signing with another wallet', async () => {
    const getMnemonic = vi.fn(() => Promise.resolve('another wallet phrase'));
    await expect(
      cosmosSend(
        { chainId: 'noble', toAddress: 'noble1x', amount: '1' },
        zignerWithoutCosmos,
        getMnemonic,
      ),
    ).rejects.toThrow(REFUSAL);
    expect(getMnemonic).not.toHaveBeenCalled();
    expect(conduitFor).not.toHaveBeenCalled();
  });

  it('refuses an ibc transfer the same way', async () => {
    const getMnemonic = vi.fn(() => Promise.resolve('another wallet phrase'));
    await expect(
      cosmosIbcTransfer(
        {
          sourceChainId: 'noble',
          destChainId: 'penumbra-1',
          sourceChannel: 'channel-0',
          toAddress: 'penumbra1x',
          amount: '1',
        },
        zignerWithoutCosmos,
        getMnemonic,
      ),
    ).rejects.toThrow(REFUSAL);
    expect(getMnemonic).not.toHaveBeenCalled();
    expect(conduitFor).not.toHaveBeenCalled();
  });

  it('signs a phrase wallet with its own phrase', async () => {
    const send = vi.fn(() => Promise.resolve({ txHash: 'h', code: 0, rawLog: '' }));
    conduitFor.mockReturnValueOnce({ send });
    const getMnemonic = vi.fn(() => Promise.resolve('own phrase'));
    const res = await cosmosSend(
      { chainId: 'noble', toAddress: 'noble1x', amount: '1' },
      { id: 'mine', type: 'mnemonic', insensitive: {} },
      getMnemonic,
    );
    expect(getMnemonic).toHaveBeenCalledWith('mine');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ mnemonic: 'own phrase' }));
    expect(res).toMatchObject({ type: 'broadcast', txHash: 'h' });
  });
});
