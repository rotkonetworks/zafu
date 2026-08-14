/**
 * When the extension is reloaded or upgraded while a page is open, this page's
 * content scripts are orphaned: they lose `chrome.*` but keep DOM access, so
 * every call into the extension throws "Extension context invalidated" and the
 * wallet silently stops working. That is confusing - the page looks connected
 * but nothing responds.
 *
 * Detecting that and telling the user to reload turns transport-error noise
 * into one clear, actionable notice. A reload re-injects fresh scripts bound to
 * the current extension context.
 */

/** True only for the orphaned-context signal, NOT transient "SW asleep" errors. */
export const isContextInvalidated = (e: unknown): boolean =>
  e instanceof Error && e.message.includes('Extension context invalidated');

const NOTICE_ID = 'zafu-reload-notice';

/** Inject a single, dismissible "reload to reconnect" bar. Idempotent. */
export const showReloadNotice = (): void => {
  if (document.getElementById(NOTICE_ID)) {
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
  bar.textContent = 'Zafu was updated. Reload this page to reconnect your wallet.';

  const reload = document.createElement('button');
  reload.textContent = 'Reload';
  reload.setAttribute(
    'style',
    'cursor:pointer;border:0;border-radius:4px;padding:4px 12px;font:600 13px system-ui;background:#111;color:#fff',
  );
  reload.addEventListener('click', () => location.reload());
  bar.appendChild(reload);

  (document.body ?? document.documentElement).appendChild(bar);
};
