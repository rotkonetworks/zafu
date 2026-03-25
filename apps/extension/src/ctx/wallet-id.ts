import { WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { getWalletReady } from './wallet-cache';

export const getWalletId = async () => {
  const wallet = await getWalletReady();
  return WalletId.fromJsonString(wallet.id);
};
