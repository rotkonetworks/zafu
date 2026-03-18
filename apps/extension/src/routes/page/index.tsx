import { redirect } from 'react-router-dom';
import { PagePath } from './paths';
import { localExtStorage } from '@repo/storage-chrome/local';

// Because Zustand initializes default empty (prior to persisted storage synced),
// We need to manually check storage for accounts in the loader.
// Will redirect to onboarding if necessary.
export const pageIndexLoader = async () => {
  const wallets = await localExtStorage.get('wallets');

  if (!wallets.length) {
    return redirect(PagePath.WELCOME);
  }

  return null;
};

export const PageIndex = () => {
  window.location.href = chrome.runtime.getURL('zitadel.html');
  return null;
};
