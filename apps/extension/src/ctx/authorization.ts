import { Code, ConnectError } from '@connectrpc/connect';
import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { AuthorizeRequest } from '@penumbra-zone/protobuf/penumbra/custody/v1/custody_pb';
import { Jsonified } from '@rotko/penumbra-types/jsonified';
import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { UserChoice } from '@repo/storage-chrome/records';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { Wallet, getCustodyTypeName } from '@repo/wallet';
import { computeEffectHash } from '@rotko/penumbra-wasm/build';
import { PopupType } from '../message/popup';
import { throwIfNeedsLogin } from '../needs-login';
import { popup } from '../popup';

export const getAuthorization = async (plan: TransactionPlan): Promise<AuthorizationData> => {
  // Check if active wallet is airgap (Zigner)
  const wallets = await localExtStorage.get('wallets');
  const activeIdx = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const activeWallet = wallets[activeIdx];

  if (activeWallet) {
    const custodyType = getCustodyTypeName(activeWallet.custody);
    if (custodyType === 'airgapSigner') {
      return getAirgapAuthorization(plan);
    }
  }

  // Normal flow: sign in parallel with user approval
  const authorize = openWallet()
    .then(custody => custody.authorizePlan(plan))
    .catch(error => {
      console.error(error);
      throw new ConnectError('Authorization failed', Code.Internal);
    });

  const choose = popup(PopupType.TxApproval, {
    authorizeRequest: new AuthorizeRequest({ plan }).toJson() as Jsonified<AuthorizeRequest>,
  })
    .then(response => response?.choice === UserChoice.Approved)
    .catch(error => {
      console.error(error);
      throw new ConnectError('Approval failed', Code.Internal);
    });

  const [authorizationData, approval] = await Promise.all([authorize, choose]);

  if (!approval) {
    throw new ConnectError('Authorization denied', Code.PermissionDenied);
  }

  return authorizationData;
};

// Airgap flow: popup handles QR display/scan, returns AuthorizationData
const getAirgapAuthorization = async (plan: TransactionPlan): Promise<AuthorizationData> => {
  // Compute the correct effect hash using WASM (requires FVK, not spend key)
  const wallets = await localExtStorage.get('wallets');
  const activeIdx = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const fvk = FullViewingKey.fromJsonString(wallets[activeIdx]!.fullViewingKey);
  const effectHashBytes = await computeEffectHash(fvk, plan);
  const effectHashHex = Array.from(effectHashBytes, (b: number) => b.toString(16).padStart(2, '0')).join('');

  const response = await popup(PopupType.TxApproval, {
    authorizeRequest: new AuthorizeRequest({ plan }).toJson() as Jsonified<AuthorizeRequest>,
    isAirgap: true,
    effectHash: effectHashHex,
  });

  if (response?.choice !== UserChoice.Approved) {
    throw new ConnectError('Authorization denied', Code.PermissionDenied);
  }

  if (!response.authorizationData) {
    throw new ConnectError('No authorization data from Zigner', Code.Internal);
  }

  return AuthorizationData.fromJson(response.authorizationData);
};

const openWallet = async () => {
  await throwIfNeedsLogin();

  const passKey = sessionExtStorage
    .get('passwordKey')
    .then(passKeyJson => Key.fromJson(passKeyJson!));

  const wallet = localExtStorage.get('wallets').then(wallets => Wallet.fromJson(wallets[0]!));

  return (await wallet).custody(await passKey);
};
