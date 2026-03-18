import { WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { Code, ConnectError } from '@connectrpc/connect';
import { getWalletFromStorage } from '@repo/storage-chrome/onboard';

export const getWalletId = async () => {
  const wallet = await getWalletFromStorage();
  if (!wallet) {
    throw new ConnectError('No wallet available', Code.FailedPrecondition);
  }

  return WalletId.fromJsonString(wallet.id);
};
