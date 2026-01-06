import { redirect } from 'react-router-dom';
import { PopupPath } from './paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';

export const needsLogin = async (): Promise<Response | null> => {
  const password = await sessionExtStorage.get('passwordKey');
  if (password) {
    return null;
  }

  return redirect(PopupPath.LOGIN);
};

export const needsOnboard = async () => {
  // check keyring vaults (new system) or legacy wallets
  const vaults = await localExtStorage.get('vaults');
  const wallets = await localExtStorage.get('wallets');
  const hasWallet = (vaults && vaults.length > 0) || (wallets && wallets.length > 0);

  if (hasWallet) {
    return null;
  }

  void chrome.runtime.openOptionsPage();
  window.close();

  return null;
};
