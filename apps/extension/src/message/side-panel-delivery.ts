/**
 * Client-side approval delivery to an already-open side panel.
 *
 * The detached-window path loads popup.html?id=<id>#<route>, so the doc reads
 * its id from the URL (see hooks/popup-ready.ts). The side panel is already
 * loaded on the wallet, so reloading it with setOptions just to show an approval
 * re-inits Penumbra WASM every time. Instead the worker sends THIS message to the
 * open panel; the panel navigates its router to `route` (no reload) and wires the
 * request listener for `popupId`. Same ready/response protocol either way.
 */

export const SIDE_PANEL_DELIVER = 'zafu-sidepanel-deliver' as const;

export interface SidePanelDeliverMessage {
  type: typeof SIDE_PANEL_DELIVER;
  /** The popup request id the worker will send the request under. */
  popupId: string;
  /** Hash-router path to navigate the panel to (e.g. '/approval/transaction'). */
  route: string;
}

export const isSidePanelDeliver = (m: unknown): m is SidePanelDeliverMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === SIDE_PANEL_DELIVER &&
  typeof (m as { popupId?: unknown }).popupId === 'string' &&
  typeof (m as { route?: unknown }).route === 'string';

/**
 * Plain client-side navigation of the open panel, with NO request wiring - used
 * for the unlock screen, which has no popup request, just "show login and let the
 * worker poll for the session key". Same no-reload idea as SIDE_PANEL_DELIVER.
 */
export const SIDE_PANEL_NAVIGATE = 'zafu-sidepanel-navigate' as const;

export interface SidePanelNavigateMessage {
  type: typeof SIDE_PANEL_NAVIGATE;
  route: string;
}

export const isSidePanelNavigate = (m: unknown): m is SidePanelNavigateMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === SIDE_PANEL_NAVIGATE &&
  typeof (m as { route?: unknown }).route === 'string';

/**
 * Navigate the open panel, re-sending every 250ms until the panel itself
 * answers `true`. A panel the click just opened mounts its listener a beat
 * after its document loads, so a single send lands on nobody (or on another
 * listener) and the panel boots to home with the request left unshown.
 */
export const navigateSidePanel = async (route: string, ms = 5_000): Promise<boolean> => {
  const until = Date.now() + ms;
  for (;;) {
    const acked = await chrome.runtime.sendMessage({ type: SIDE_PANEL_NAVIGATE, route }).then(
      r => r === true,
      () => false,
    );
    if (acked) {
      return true;
    }
    if (Date.now() >= until) {
      return false;
    }
    await new Promise(r => setTimeout(r, 250));
  }
};
