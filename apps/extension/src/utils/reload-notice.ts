/**
 * When the extension is reloaded or upgraded while a page is open, every
 * document it had injected loses its `chrome.*` bindings: content scripts in
 * web pages, and zafu's OWN pages (the side panel, popups, the options page).
 * Each call into the extension then throws "Extension context invalidated" and
 * the wallet silently stops working - the page looks alive but nothing
 * responds. That is especially confusing after an MV3 auto-update, which does
 * not always close already-open extension pages.
 *
 * Detecting that and telling the user to reload turns a transport-error storm
 * into one clear, actionable notice. A reload re-binds fresh scripts to the
 * current extension context.
 *
 * Shared by the content-script bridge (`content-scripts/message/send-background.ts`)
 * and the extension's own pages (`utils/graceful-network-errors.ts`).
 */

/**
 * True only for the orphaned-context signal, NOT transient "SW asleep" errors.
 * Walks a bounded `cause` chain: the penumbra transport wraps the original
 * error in a `ConnectError`, so the message is not always on the outer value.
 */
/** this document's extension bindings are gone: the extension was reloaded under it */
export const runtimeGone = (): boolean =>
  typeof chrome === 'undefined' || !chrome.runtime?.id || chrome.runtime.id === 'invalid';

export const isContextInvalidated = (e: unknown, depth = 0): boolean => {
  if (depth > 3 || e == null || typeof e !== 'object') {
    return false;
  }
  // newer chrome drops `chrome.runtime` from an orphaned script altogether, so
  // the call fails before it can say "invalidated"
  if (
    e instanceof Error &&
    (e.message.includes('Extension context invalidated') || runtimeGone())
  ) {
    return true;
  }
  if ('cause' in e) {
    return isContextInvalidated((e as { cause: unknown }).cause, depth + 1);
  }
  return false;
};

/**
 * Teardowns to run the first time an orphaned context is observed, plus the
 * latch that makes detection one-shot. A page that keeps being poked after a
 * reload would otherwise retry (and log) on every poke: the content-script
 * bridge hits `sendMessage` on each window message and logs the rejection each
 * time, which is the storm this file is supposed to end.
 */
const invalidationListeners = new Set<() => void>();
let invalidated = false;

/**
 * Run `listener` when this document is found to be orphaned. Registers for
 * later, or runs immediately if the context is already known dead - so a
 * teardown added after detection still fires.
 */
export const onContextInvalidated = (listener: () => void): void => {
  if (invalidated) {
    listener();
    return;
  }
  invalidationListeners.add(listener);
};

/**
 * Report that this document's extension context is dead. Idempotent: the first
 * caller logs one debug line, shows the notice, and runs every teardown; later
 * callers do nothing. Everything else about the orphaned state is expected, so
 * none of it is worth a console error.
 */
export const noteContextInvalidated = (): void => {
  if (invalidated) {
    return;
  }
  invalidated = true;
  console.debug('[zafu] extension context invalidated; reload this page to reconnect');
  showReloadNotice();
  for (const listener of invalidationListeners) {
    try {
      listener();
    } catch {
      // Teardown is best-effort: a listener that throws must not stop the rest.
    }
  }
  invalidationListeners.clear();
};

const NOTICE_ID = 'zafu-reload-notice';

/** Inject a single, dismissible "reload to reconnect" bar. Idempotent. */
const showReloadNotice = (): void => {
  if (typeof document === 'undefined' || document.getElementById(NOTICE_ID)) {
    return;
  }
  const bar = document.createElement('div');
  bar.id = NOTICE_ID;
  bar.setAttribute(
    'style',
    [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'display:flex',
      'gap:12px',
      'align-items:center',
      'justify-content:center',
      'padding:10px 16px',
      'font:500 13px/1.4 system-ui,sans-serif',
      'color:#111',
      'background:#f5c542',
      'box-shadow:0 1px 4px rgba(0,0,0,.25)',
    ].join(';'),
  );
  bar.textContent = 'zafu was updated · please reload this page to reconnect your wallet';

  const reload = document.createElement('button');
  reload.textContent = 'reload';
  reload.setAttribute(
    'style',
    'cursor:pointer;border:0;border-radius:4px;padding:4px 12px;font:600 13px system-ui;background:#111;color:#fff',
  );
  reload.addEventListener('click', () => location.reload());
  bar.appendChild(reload);

  (document.body ?? document.documentElement).appendChild(bar);
};
