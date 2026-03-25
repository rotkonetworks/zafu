import { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { getWalletReady } from './wallet-cache';

export const getFullViewingKey = async () => {
  const wallet = await getWalletReady();
  return FullViewingKey.fromJsonString(wallet.fullViewingKey);
};
