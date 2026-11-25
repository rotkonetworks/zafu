/**
 * Ask a site's question in an approval window: unlocked first, one window per
 * site as every prompt, and a window closed without deciding is a rejection.
 * The request waits in session storage under `stashKey` for the screen at
 * `route` to read; the screen answers with a `zafu_keplr_result` message,
 * which keplrMessageListener hands back here by request id.
 */

import {
  openApprovalPopup,
  registerPendingApproval,
  takePendingApproval,
} from './external-easteregg';

export interface Decision {
  approved: boolean;
  payload?: unknown;
  error?: string;
}

export async function askInWindow(
  route: string,
  stashKey: string,
  req: { requestId: string; origin: string },
): Promise<Decision> {
  const { throwIfNeedsLogin } = await import('../../needs-login');
  // the site waits after a dismissed unlock, as for every other prompt
  await throwIfNeedsLogin(req.origin);
  await chrome.storage.session.set({ [stashKey]: req });
  // the closed-window sweep answers { cancelled: true }, which is no approval
  const decision = new Promise<Decision>(resolve =>
    registerPendingApproval(req.requestId, r => {
      const d = r as (Partial<Decision> & { cancelled?: boolean }) | undefined;
      resolve(
        d?.approved === true
          ? { approved: true, payload: d.payload }
          : { approved: false, error: d?.cancelled ? 'request rejected' : d?.error },
      );
    }),
  );
  const params = new URLSearchParams({ requestId: req.requestId });
  const url = chrome.runtime.getURL(`popup.html#/${route}?${params.toString()}`);
  try {
    if (!(await openApprovalPopup(req.origin, url, req.requestId))) {
      takePendingApproval(req.requestId);
      return {
        approved: false,
        error: "zafu couldn't open this request · another from this site may still be open",
      };
    }
    return await decision;
  } finally {
    void chrome.storage.session.remove(stashKey);
  }
}
