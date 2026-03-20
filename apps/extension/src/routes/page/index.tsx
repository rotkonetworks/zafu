import { redirect } from 'react-router-dom';
import { PagePath } from './paths';
import { localExtStorage } from '@repo/storage-chrome/local';

// Because Zustand initializes default empty (prior to persisted storage synced),
// We need to manually check storage for accounts in the loader.
// Will redirect to onboarding if necessary.
export const pageIndexLoader = async () => {
  // use vaults (unencrypted metadata) to check if user has wallets —
  // wallets array is now encrypted at rest, can't read without session key
  const vaults = await localExtStorage.get('vaults');

  if (!vaults || !vaults.length) {
    return redirect(PagePath.WELCOME);
  }

  return null;
};

export const PageIndex = () => {
  window.location.href = chrome.runtime.getURL('zitadel.html');
  return null;
};
