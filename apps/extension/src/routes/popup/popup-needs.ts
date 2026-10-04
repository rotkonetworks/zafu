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
  PopupPath.FORGOT_PASSWORD,
  PopupPath.WELCOME,
  PopupPath.COSMOS_SIGN,
  PopupPath.MULTISIG_SIGN,
  PopupPath.CONTACT_PICKER,
  PopupPath.FROST_APPROVE,
  PopupPath.PASSKEY_APPROVE,
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

/** No wallet yet: show the ways in instead of an unlock screen with nothing to unlock. */
export const needsOnboard = async (): Promise<Response | null> => {
  // vaults are unencrypted metadata - wallets themselves are encrypted at rest
  const vaults = await localExtStorage.get('vaults');
  return vaults?.length ? null : redirect(PopupPath.WELCOME);
};
