import { PopupPath } from './routes/popup/paths';
import { PopupRequest, PopupResponse, PopupType } from './message/popup';
import { sendPopup } from './message/send-popup';
import { listenReady } from './message/listen-ready';
import { throwIfNeedsLogin } from './needs-login';
import { openApprovalPopup } from './utils/popup-window';
import { localExtStorage } from '@repo/storage-chrome/local';
import { isSidePanelOpen } from './side-panel-presence';
import { SIDE_PANEL_DELIVER } from './message/side-panel-delivery';

const POPUP_READY_TIMEOUT = 60_000;
// How long to wait for the open side panel to ACK an approval. Delivery is now a
// client-side route change (a message the panel navigates on), not a document
// reload, so this no longer has to cover a Penumbra WASM cold-start - it only
// guards "is a panel actually listening": no ack in this window -> fall back to
// a popup window. Kept generous to absorb a busy main thread.
const SIDE_PANEL_READY_TIMEOUT = 6_000;
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

    const popupId = await spawnDetachedPopup(popupType).catch(cause => {
      throw new Error(`Popup ${popupType} failed to open`, { cause });
    });

    const popupRequest = {
      [popupType]: request,
      id: popupId,
    } as PopupRequest<M>;

    // No side-panel "restore" here anymore: the panel's document path never
    // changes (delivery is a client-side navigation), and the approval screen
    // returns the panel to the wallet itself via exitApprovalSurface. A detached
    // window closes itself the same way.
    return await sendPopup(popupRequest);
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

/**
 * Deliver an approval into an already-open side panel WITHOUT reloading it.
 *
 * The panel is already on the wallet, so instead of setOptions (which reloads the
 * panel document and re-inits Penumbra WASM every approval), we message the panel
 * to navigate its router to the approval route - a client-side change, like the
 * in-app zcash flow. The panel's delivery listener (useSidePanelDelivery) wires
 * the request listener and pings ready, which resolves `ready` here. If no panel
 * is listening (closed, or in another window), ready times out and we return
 * false so the caller falls back to a popup window. The panel's document path is
 * never touched, so there is nothing to restore afterward.
 */
const deliverToSidePanel = async (popupType: PopupType, popupId: string): Promise<boolean> => {
  const ready = listenReady(popupId, AbortSignal.timeout(SIDE_PANEL_READY_TIMEOUT));
  const route = POPUP_PATHS[popupType];
  const send = () =>
    chrome.runtime
      .sendMessage({ type: SIDE_PANEL_DELIVER, popupId, route })
      .catch(() => undefined); // no receiver yet -> retry below, else ready times out
  // Send immediately, then retry on an interval until the panel acks (ready) or
  // we time out. An ALREADY-open panel acks on the first send; a FRESHLY-opened
  // panel (see spawnDetachedPopup's sidePanel.open) mounts its delivery listener
  // a beat after the document loads, so the first send can land before anyone is
  // listening - retrying lets that cold panel still receive the approval instead
  // of dropping it and falling back to a window.
  void send();
  const interval = setInterval(() => void send(), 250);
  try {
    await ready;
    return true;
  } catch {
    return false;
  } finally {
    clearInterval(interval);
  }
};

/**
 * Spawns a detached approval and resolves when it is ready. Honours the user's
 * `approvalsInSidePanel` preference: deliver into the open side panel first, else
 * open a popup window (also the fallback when the panel is closed). Returns the
 * popup id the request will be sent under.
 */
const spawnDetachedPopup = async (popupType: PopupType): Promise<string> => {
  const popupId = crypto.randomUUID();

  // Presence MUST be scoped to the window the user is actually looking at.
  // getContexts is global, so a panel open in another window (or a stale/
  // enabled-but-not-visible one) read as "open" - we would then deliver to a
  // panel the user cannot see, its ack would never come, and we'd fall back to a
  // window anyway after the timeout. With many penumbra approvals that was the
  // reported "still pushes a lot of popups even in side-panel mode". Scoping
  // means: panel visible in THIS window -> deliver there; not here -> straight to
  // the window with no wasted wait.
  const winId = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .then(w => w.id)
    .catch(() => undefined);

  // default ON: side panel is the default approval surface. Only an explicit
  // `false` (user picked "popup window") opts out.
  const wantSidebar = (await localExtStorage.get('approvalsInSidePanel')) !== false;
  if (wantSidebar) {
    let panelOpen = await isSidePanelOpen(winId);

    // If the panel is CLOSED, try to open it before falling back to a popup. A
    // dapp connect (and an approval prompted by a page action) is driven by a
    // user click on the page, which Chrome MAY accept as the user gesture that
    // chrome.sidePanel.open() requires. When it does, the approval lands in the
    // side panel - what "side panel mode" should do on connect, instead of the
    // popup users kept seeing. When no gesture propagated, open() throws and we
    // fall straight through to the popup window below (prior behavior, no change).
    if (!panelOpen && winId != null) {
      try {
        await chrome.sidePanel.open({ windowId: winId });
        panelOpen = true;
      } catch {
        // no user gesture available in this context - popup fallback below
      }
    }

    if (panelOpen) {
      const shown = await deliverToSidePanel(popupType, popupId).catch(() => false);
      if (shown) {
        return popupId;
      }
    }
  }

  const ready = listenReady(popupId, AbortSignal.timeout(POPUP_READY_TIMEOUT));
  const created = await openApprovalPopup(popupUrl(popupType, popupId).href);
  // window id is guaranteed present after `create`
  void ready.catch(() => chrome.windows.remove(created.id!));
  await ready;
  return popupId;
};
