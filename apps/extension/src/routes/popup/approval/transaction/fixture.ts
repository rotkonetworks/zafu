/**
 * Harness-only: a small penumbra plan for the review screen (see
 * use-approval-fixture.ts). It pays 1.5 um to this wallet's own address, so
 * every perspective has something to show; `?airgap=1` asks for the zigner
 * path. Never runs in a Web Store install.
 */

import { AuthorizeRequest } from '@penumbra-zone/protobuf/penumbra/custody/v1/custody_pb';
import { TransactionPlan } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { viewClient } from '../../../../clients';

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

export const fixtureTxRequest = async (airgap: boolean) => {
  const { address } = await viewClient.addressByIndex({ addressIndex: { account: 0 } });
  const { stakingAssetId } = new ChainRegistryClient().bundled.globals();
  const plan = new TransactionPlan({
    actions: [
      {
        action: {
          case: 'output',
          value: {
            value: { amount: { lo: 1_500_000n }, assetId: stakingAssetId },
            destAddress: address,
            rseed: bytes(7),
            valueBlinding: bytes(3),
            proofBlindingR: bytes(5),
            proofBlindingS: bytes(9),
          },
        },
      },
    ],
    transactionParameters: {
      chainId: 'penumbra-1',
      fee: { amount: { lo: 2_000n }, assetId: stakingAssetId },
    },
    memo: { plaintext: { returnAddress: address, text: 'thank you' }, key: bytes(1) },
  });
  return {
    authorizeRequest: new AuthorizeRequest({ plan }).toJson() as never,
    isAirgap: airgap,
    effectHash: airgap ? 'ab'.repeat(64) : undefined,
  };
};
