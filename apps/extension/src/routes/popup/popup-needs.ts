import { redirect } from 'react-router-dom';
import { PopupPath } from './paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';

/**
 * Screens that handle their own login state: the unlock screen itself, home
 * (its own loader), and flows the service worker opens and gates
 * (approvals, signing, pickers).
 */
const OWN_LOGIN_HANDLING = [
  PopupPath.INDEX,
  PopupPath.LOGIN,
  PopupPath.COSMOS_SIGN,
  PopupPath.MULTISIG_SIGN,
  PopupPath.CONTACT_PICKER,
  PopupPath.FROST_APPROVE,
];

export const handlesOwnLogin = (path: string): boolean =>
  path.startsWith('/approval/') || (OWN_LOGIN_HANDLING as string[]).includes(path);

/** Only our own screens are valid `next` targets after unlock. */
export const safeNext = (next: string | null): string | null =>
  next && next.startsWith('/') && !next.startsWith('//') && !handlesOwnLogin(next.split('?')[0]!)
    ? next
    : null;

/**
 * Every other screen needs an unlocked wallet. Opened directly while locked
 * (a dapp handoff, a side panel reopening where it was, a deep link) it used
 * to render as if unlocked - 'deriving...' forever, 'no wallet', 'spendable:
 * 0'. Redirect to unlock instead, and come back afterwards.
 */
export const lockedScreenGuard = async ({
  request,
}: {
  request: Request;
}): Promise<Response | null> => {
  const url = new URL(request.url);
  if (handlesOwnLogin(url.pathname)) {
    return null;
  }
  if (await sessionExtStorage.get('passwordKey')) {
    return null;
  }
  return redirect(`${PopupPath.LOGIN}?next=${encodeURIComponent(url.pathname + url.search)}`);
};

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
