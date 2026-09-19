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

// Guards against opening the options page more than once. popupIndexLoader
// calls needsOnboard() and then falls through to needsLogin() -> LOGIN, whose
// popupLoginLoader calls needsOnboard() again; without this flag an un-onboarded
// wallet fires openOptionsPage() twice. Returning a redirect instead is not an
// option: the LOGIN loader redirecting to LOGIN would infinite-loop.
let onboardingPromptOpened = false;

export const needsOnboard = async () => {
  // use vaults (unencrypted metadata) — wallets are encrypted at rest
  const vaults = await localExtStorage.get('vaults');

  if (vaults && vaults.length > 0) {
    return null;
  }

  if (!onboardingPromptOpened) {
    onboardingPromptOpened = true;
    void chrome.runtime.openOptionsPage();
  }
  // In a popup this closes it (user never sees Login); in a side panel / window
  // close() is a no-op, so the options page is where onboarding continues.
  window.close();

  return null;
};
