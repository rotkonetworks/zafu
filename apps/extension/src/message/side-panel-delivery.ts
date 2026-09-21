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
