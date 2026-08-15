import { PopupPath } from './routes/popup/paths';
import { PopupRequest, PopupResponse, PopupType } from './message/popup';
import { sendPopup } from './message/send-popup';
import { listenReady } from './message/listen-ready';
import { throwIfNeedsLogin } from './needs-login';
import { openApprovalPopup } from './utils/popup-window';
import { localExtStorage } from '@repo/storage-chrome/local';
import { isSidePanelOpen } from './side-panel-presence';

const POPUP_READY_TIMEOUT = 60_000;
// How long to wait for the side panel to render an approval before deciding it
// is closed and falling back to a popup window. Short: an open panel renders
// almost instantly (same bundle); a closed one never signals ready.
const SIDE_PANEL_READY_TIMEOUT = 1_500;
const SIDE_PANEL_DEFAULT_PATH = 'sidepanel.html';
const POPUP_PATHS = {
  [PopupType.TxApproval]: PopupPath.TRANSACTION_APPROVAL,
  [PopupType.OriginApproval]: PopupPath.ORIGIN_APPROVAL,
  [PopupType.SignRequest]: PopupPath.SIGN_APPROVAL,
} as const;
const POPUP_BASE = chrome.runtime.getURL('/popup.html');

/**
 * Thrown when a popup of the requested type is already open. Distinct from a
 * generic failure so the connect path can surface the existing window and
 * treat the duplicate request as benign (not a denial). See
 * content-script-connect.ts.
 */
export class PopupAlreadyOpenError extends Error {
  constructor(popupType: PopupType) {
    super(`Popup ${popupType} already open`);
    this.name = 'PopupAlreadyOpenError';
  }
}

/**
 * Find an already-open approval popup window and bring it to the front. The
 * ephemeral service worker can lose track of a popup it opened (idle teardown),
 * and a popup can also land off-screen or behind the browser; a second connect
 * click should surface that window rather than silently fail.
 */
const focusExistingPopup = async (): Promise<void> => {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    const ours = wins.find(w => w.tabs?.some(t => t.url?.startsWith(POPUP_BASE)));
    if (ours?.id != null) {
      await chrome.windows.update(ours.id, { focused: true, drawAttention: true });
    }
  } catch {
    // best-effort; the throw below still informs the caller
  }
};

/**
 * Launch a popup dialog to obtain a decision from the user. Returns the user
 * decision, or `null` if the popup is closed without interaction.
 */
export const popup = async <M extends PopupType>(
  popupType: M,
  request: PopupRequest<M>[M],
): Promise<PopupResponse<M>[M] | null> => {
  await throwIfNeedsLogin();

  const lockGranted = async (lock: Lock | null): Promise<PopupResponse<M> | null> => {
    if (!lock) {
      // Another approval of this type is in flight. Surface its window and let
      // the caller treat this duplicate as benign rather than a denial.
      await focusExistingPopup();
      throw new PopupAlreadyOpenError(popupType);
    }

    const { popupId, viaSidePanel } = await spawnDetachedPopup(popupType).catch(cause => {
      throw new Error(`Popup ${popupType} failed to open`, { cause });
    });

    const popupRequest = {
      [popupType]: request,
      id: popupId,
    } as PopupRequest<M>;

    try {
      return await sendPopup(popupRequest);
    } finally {
      // Return the panel to the wallet once the approval is answered (or the
      // panel was closed mid-flow), so it does not stay stuck on the approval.
      if (viaSidePanel) {
        await restoreSidePanel();
      }
    }
  };

  const popupResponse = await navigator.locks.request(
    popupType,
    { ifAvailable: true, mode: 'exclusive' },
    lockGranted,
  );

  if (popupResponse == null) {
    return null;
  } else {
    return popupResponse[popupType] as PopupResponse<M>[M] | null;
  }
};

/**
 * The popup document uses a hash router. Each popup type has a unique path in
 * the router. The popup id is a query parameter and does not affect routing.
 */
const popupUrl = (popupType?: PopupType, id?: string): URL => {
  const pop = new URL(POPUP_BASE);

  if (popupType) {
    pop.hash = POPUP_PATHS[popupType];
  }

  if (id) {
    pop.searchParams.set('id', id);
  }

  return pop;
};

/** Relative path (from the extension root) to an approval in the popup app. */
const relativePopupPath = (popupType: PopupType, id: string): string =>
  `popup.html?id=${id}#${POPUP_PATHS[popupType]}`;

/** Point the side panel back at the wallet home after an approval is done. */
const restoreSidePanel = (): Promise<void> =>
  chrome.sidePanel
    .setOptions({ path: SIDE_PANEL_DEFAULT_PATH, enabled: true })
    .catch(() => undefined);

/**
 * Route an approval into the side panel if it is open. `setOptions` reloads the
 * (already-open) panel to the approval - same bundle as the popup, so it just
 * renders the route and signals ready. If the panel is closed it never renders,
 * `ready` times out, and we return false so the caller falls back to a popup
 * window. This also honours MV3's gesture rule: we never force the panel open
 * from a background event, we only reuse it when the user already had it open.
 */
const deliverToSidePanel = async (path: string, popupId: string): Promise<boolean> => {
  const ready = listenReady(popupId, AbortSignal.timeout(SIDE_PANEL_READY_TIMEOUT));
  await chrome.sidePanel.setOptions({ path, enabled: true });
  try {
    await ready;
    return true;
  } catch {
    await restoreSidePanel();
    return false;
  }
};

/**
 * Spawns a detached approval and resolves when it is ready. Honours the user's
 * `approvalsInSidePanel` preference: try the open side panel first, else open a
 * popup window (also the fallback when the panel is closed). Returns whether the
 * side panel was used, so the caller can restore it afterward.
 */
const spawnDetachedPopup = async (
  popupType: PopupType,
): Promise<{ popupId: string; viaSidePanel: boolean }> => {
  const popupId = crypto.randomUUID();

  // Only route into the side panel when it is actually open (real presence,
  // not a render-timeout guess) - otherwise we would setOptions/restore a closed
  // panel and could race a slow render against the fallback window.
  if (isSidePanelOpen() && (await localExtStorage.get('approvalsInSidePanel')) === true) {
    const shown = await deliverToSidePanel(relativePopupPath(popupType, popupId), popupId).catch(
      () => false,
    );
    if (shown) {
      return { popupId, viaSidePanel: true };
    }
  }

  const ready = listenReady(popupId, AbortSignal.timeout(POPUP_READY_TIMEOUT));
  const created = await openApprovalPopup(popupUrl(popupType, popupId).href);
  // window id is guaranteed present after `create`
  void ready.catch(() => chrome.windows.remove(created.id!));
  await ready;
  return { popupId, viaSidePanel: false };
};
