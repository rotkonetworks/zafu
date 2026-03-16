import { WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { Code, ConnectError } from '@connectrpc/connect';
import { localExtStorage } from '@repo/storage-chrome/local';

export const getWalletId = async () => {
  const wallets = await localExtStorage.get('wallets');
  const activeIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const wallet = wallets[activeIndex] ?? wallets[0];
  if (!wallet) {
    throw new ConnectError('No wallet available', Code.FailedPrecondition);
  }

  return WalletId.fromJsonString(wallet.id);
};
