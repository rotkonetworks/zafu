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
  // use vaults (unencrypted metadata) — wallets are encrypted at rest
  const vaults = await localExtStorage.get('vaults');

  if (vaults && vaults.length > 0) {
    return null;
  }

  void chrome.runtime.openOptionsPage();
  window.close();

  return null;
};
