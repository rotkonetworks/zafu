import { localExtStorage } from '@repo/storage-chrome/local';

/**
 * Where approvals (connect, sign, send) are shown:
 *
 * - `hybrid`: the side panel, falling back to a popup window when no panel can
 *   take it (the default, and what every install had before this setting).
 * - `sidebar`: only ever the side panel. If none can be opened, the toolbar
 *   icon shows a badge and the approval waits for the user to open the panel.
 * - `popup`: always a separate popup window.
 */
export type ApprovalSurface = 'hybrid' | 'sidebar' | 'popup';

/** Older installs only have the boolean `approvalsInSidePanel`. */
export const resolveApprovalSurface = (
  surface: ApprovalSurface | undefined,
  legacyInSidePanel: boolean | undefined,
): ApprovalSurface => surface ?? (legacyInSidePanel === false ? 'popup' : 'hybrid');

export const getApprovalSurface = async (): Promise<ApprovalSurface> =>
  resolveApprovalSurface(
    await localExtStorage.get('approvalSurface'),
    await localExtStorage.get('approvalsInSidePanel'),
  );

/**
 * In-memory mirror of the preference, so an approval listener can decide
 * whether to open the side panel WITHOUT an awaited storage read.
 *
 * Why this exists: `chrome.sidePanel.open()` only works when called with no
 * `await` before it in the user-gesture task (see openPanelOnGesture). An
 * awaited `localExtStorage.get(...)` right before the open is exactly what loses
 * the gesture and forces the popup fallback. Reading a cached value is
 * synchronous, so the open stays inside the gesture.
 */
let cached: ApprovalSurface = 'hybrid';

/**
 * The toolbar icon follows the same preference: the side panel for `hybrid`
 * and `sidebar`, the popup for `popup`. Done at runtime because a manifest
 * `default_popup` always wins over `openPanelOnActionClick`.
 */
export const applyActionSurface = (surface: ApprovalSurface): void => {
  const popup = surface === 'popup';
  void chrome.action?.setPopup({ popup: popup ? 'popup.html' : '' }).catch(() => undefined);
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: !popup }).catch(() => {
    // side panel not supported in this browser version
  });
};

const refresh = (): void => {
  void getApprovalSurface()
    .then(value => {
      cached = value;
      applyActionSurface(value);
    })
    .catch(() => applyActionSurface(cached));
};

/** Call once at service-worker startup. Seeds the cache and keeps it current. */
export const initSidePanelPref = (): void => {
  refresh();
  try {
    localExtStorage.addListener(() => refresh());
  } catch {
    // storage listener unavailable - the seeded value still serves.
  }
};

/**
 * The side panel open a dapp's gesture just asked Chrome for.
 *
 * `sidePanel.open()` resolving means Chrome accepted it and the panel IS
 * coming, it just may take seconds to load the bundle and show up in
 * getContexts. The approval path used to give it a fixed 2s, then open a
 * popup window as well - so a slow panel produced a panel AND a popup.
 * Recording the open lets that path wait for a panel it knows is coming,
 * and fall back straight away when Chrome refused.
 */
let pendingOpen: { at: number; accepted: Promise<boolean> } | undefined;
const PENDING_OPEN_FRESH_MS = 5_000;

/**
 * Open the side panel for an approval a dapp's click just asked for.
 *
 * Call it with nothing awaited before it in the message's task: the click's
 * transient activation rides the message, and `chrome.sidePanel.open()` only
 * counts as gesture-driven inside that same task. After an await Chrome
 * refuses it, and the approval waits 2s for a panel before falling back to a
 * window. Best-effort; with the `popup` surface it does nothing.
 */
export const openPanelOnGesture = (sender: chrome.runtime.MessageSender): void => {
  if (cached === 'popup' || sender.tab?.id == null || !chrome.sidePanel) {
    return;
  }
  const open = chrome.sidePanel.open({ tabId: sender.tab.id });
  pendingOpen = {
    at: Date.now(),
    accepted: open.then(
      () => true,
      () => false,
    ),
  };
};

/** Whether a recent gesture open was accepted by Chrome; undefined if none. */
export const recentPanelOpenAccepted = (): Promise<boolean> | undefined =>
  pendingOpen && Date.now() - pendingOpen.at < PENDING_OPEN_FRESH_MS
    ? pendingOpen.accepted
    : undefined;
