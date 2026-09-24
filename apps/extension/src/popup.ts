import { PopupPath } from './routes/popup/paths';
import { PopupRequest, PopupResponse, PopupType } from './message/popup';
import { sendPopup } from './message/send-popup';
import { listenReady } from './message/listen-ready';
import { throwIfNeedsLogin } from './needs-login';
import { openApprovalPopup } from './utils/popup-window';
import { getApprovalSurface, recentPanelOpenAccepted } from './side-panel-pref';
import { isSidePanelOpen } from './side-panel-presence';
import { SIDE_PANEL_DELIVER } from './message/side-panel-delivery';
import { rescue, detachedContext, UnavailableError, type Service } from '@zafu/service';

const POPUP_READY_TIMEOUT = 60_000;
// How long to wait for the open side panel to ACK an approval. Delivery is now a
// client-side route change (a message the panel navigates on), not a document
// reload, so this no longer has to cover a Penumbra WASM cold-start - it only
// guards "is a panel actually listening": no ack in this window -> fall back to
// a popup window. Kept generous to absorb a busy main thread.
// A cold panel must load the popup bundle and init Penumbra wasm before its
// delivery listener mounts; 6s was too short on a busy machine, the approval
// then fell back to a popup window while the panel finished opening anyway.
const SIDE_PANEL_READY_TIMEOUT = 15_000;
// How long to wait for a panel to appear in getContexts when nothing says one
// is coming.
const SIDE_PANEL_REGISTER_WAIT = 2_000;
// ...and when Chrome accepted the connect gesture's sidePanel.open(), so a
// panel IS coming and only its cold load is slow. Opening a popup window
// before this ran out is what gave users a side panel AND a popup.
const SIDE_PANEL_ACCEPTED_WAIT = 15_000;
// Sidebar-only mode: how long an approval waits for the user to open the
// panel from the badged toolbar icon before it is dropped (as a closed popup).
const SIDEBAR_ONLY_WAIT = 120_000;

/** Poll until a side panel is visible in `winId`, or `ms` elapses. */
const waitForSidePanel = async (winId: number | undefined, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 150);
    });
    if (await isSidePanelOpen(winId)) {
      return true;
    }
  }
  return false;
};
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

    // Surface exception owned by zafu, not the app: an airgap (Zigner) approval
    // shows/scans QR codes, which a side panel is too narrow for. Force a full
    // popup window for it regardless of the user's side-panel preference. The
    // app never chooses this - it only sets `isAirgap` on the request; zafu
    // decides the surface, so the experience stays consistent.
    const forceWindow =
      (popupType === PopupType.TxApproval || popupType === PopupType.SignRequest) &&
      (request as { isAirgap?: boolean }).isAirgap === true;

    const popupId = await spawnDetachedPopup(popupType, forceWindow).catch(cause => {
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
 * Intent-first name for {@link popup}: an app requests a user interaction and
 * zafu decides the surface (side panel vs window) from the user's preference and
 * the interaction kind - never the app's choice. Callers migrate to this name
 * over time; it is the seam a future `@zafu/interactions` package builds on.
 */
export const present = popup;

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
const spawnDetachedPopup = async (
  popupType: PopupType,
  // When true, skip the side panel entirely and open a full popup window - used
  // for airgap (Zigner) approvals whose QR display/scan does not fit a panel.
  // The user's side-panel preference is respected for every other approval.
  forceWindow = false,
): Promise<string> => {
  const popupId = crypto.randomUUID();

  // The window surface: open a detached popup window and resolve when its
  // approval document is ready. Also the fallback for the side-panel surface.
  const openInWindow: Service<void, string> = async () => {
    const ready = listenReady(popupId, AbortSignal.timeout(POPUP_READY_TIMEOUT));
    const created = await openApprovalPopup(popupUrl(popupType, popupId).href);
    // window id is guaranteed present after `create`
    void ready.catch(() => chrome.windows.remove(created.id!));
    await ready;
    return popupId;
  };

  // The surface is the wallet's decision (user preference), never the app's.
  // An airgap approval (forceWindow) always gets a window.
  const surface = forceWindow ? 'popup' : await getApprovalSurface();
  if (surface === 'popup') {
    return openInWindow(undefined, detachedContext);
  }

  // The side-panel surface: deliver into the panel visible in the window the
  // user is looking at. Presence MUST be scoped to that window - getContexts is
  // global, so a panel open in another window would read as "open" and its ack
  // would never come. Throws UnavailableError when the panel cannot take the
  // approval, which the rescue below turns into the window fallback.
  const deliverToOpenSidePanel: Service<void, string> = async () => {
    const winId = await chrome.windows
      .getLastFocused({ windowTypes: ['normal'] })
      .then(w => w.id)
      .catch(() => undefined);

    let panelOpen = await isSidePanelOpen(winId);
    // The connect gesture (content-script-connect) opens the panel a beat before
    // this runs, but a just-opened panel is not in getContexts yet. Treating that
    // as "closed" sent us to the gesture-less open below (which Chrome refuses)
    // and then to the window fallback - so the user got the side panel AND a
    // popup. Wait for it: long when Chrome accepted that open (the panel is
    // coming, just slowly), briefly otherwise.
    if (!panelOpen) {
      const accepted = await recentPanelOpenAccepted();
      panelOpen = await waitForSidePanel(
        winId,
        accepted ? SIDE_PANEL_ACCEPTED_WAIT : SIDE_PANEL_REGISTER_WAIT,
      );
    }
    // A closed panel is normally opened on the connect gesture (see
    // content-script-connect). This best-effort open covers an approval that
    // arrives with the panel openable; by here we are past the gesture and only
    // delivering, so an await before it is fine.
    if (!panelOpen && winId != null) {
      try {
        await chrome.sidePanel.open({ windowId: winId });
        panelOpen = true;
      } catch {
        // no panel, and none openable in this context
      }
    }
    if (!panelOpen) {
      throw new UnavailableError('side panel is not open in this window');
    }
    const shown = await deliverToSidePanel(popupType, popupId).catch(() => false);
    if (!shown) {
      throw new UnavailableError('side panel did not acknowledge the approval');
    }
    return popupId;
  };

  // Sidebar only: never a window. When no panel could take the approval, badge
  // the toolbar icon (its click opens the panel) and deliver once it opens.
  const waitForUserToOpenPanel: Service<void, string> = async () => {
    await chrome.action.setBadgeText({ text: '1' }).catch(() => undefined);
    await chrome.action
      .setTitle({ title: 'zafu - approval waiting, click to open' })
      .catch(() => undefined);
    try {
      const winId = await chrome.windows
        .getLastFocused({ windowTypes: ['normal'] })
        .then(w => w.id)
        .catch(() => undefined);
      if (!(await waitForSidePanel(winId, SIDEBAR_ONLY_WAIT))) {
        throw new UnavailableError('side panel was not opened for the approval');
      }
      if (!(await deliverToSidePanel(popupType, popupId).catch(() => false))) {
        throw new UnavailableError('side panel did not acknowledge the approval');
      }
      return popupId;
    } finally {
      await chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
      await chrome.action.setTitle({ title: 'zafu' }).catch(() => undefined);
    }
  };

  // Hybrid: try the side panel; on ANY failure fall back to a popup window.
  // `rescue` (from @zafu/service) keeps that fallback a value-level combinator
  // instead of a nested try/catch - the shared services pattern the wallet is
  // standardizing on for interaction surface routing.
  return rescue(deliverToOpenSidePanel(undefined, detachedContext), () =>
    surface === 'sidebar'
      ? waitForUserToOpenPanel(undefined, detachedContext)
      : openInWindow(undefined, detachedContext),
  );
};
