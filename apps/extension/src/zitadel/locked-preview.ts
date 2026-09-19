/**
 * Locked-preview teaser shown to a visitor with NO zafu identity.
 *
 * The growth hook: a no-ZID observer sees the citadel is alive and encrypted but
 * can't read it, which drives the "get zafu to unlock" download. Honest by
 * construction - this is a STYLIZED LOCKED PREVIEW, not real intercepted
 * messages: there is no plaintext being hidden here (the ciphertext rows are
 * decorative, generated locally), so nothing is being misrepresented as
 * decrypted-elsewhere. DMs are genuinely E2EE and rooms are genuinely gated by
 * having a ZID; this screen just says so and points at the download.
 *
 * Vanilla DOM to match main.tsx. No emoji (repo rule) - the lock is inline SVG.
 */

const ZAFU_DOWNLOAD_URL = 'https://zafu.pro';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A line of decorative base64-looking ciphertext of the given length. */
function cipherLine(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += B64[(Math.random() * B64.length) | 0];
  }
  return s;
}

/** A fake channel row: a faintly-visible channel name + a blurred cipher body. */
function cipherRow(label: string): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'margin:0 0 14px 0';

  const name = document.createElement('div');
  name.textContent = label;
  name.style.cssText = 'color:#6a6a6a;font-size:11px;margin-bottom:4px;letter-spacing:0.04em';
  row.appendChild(name);

  const body = document.createElement('div');
  // The cipher text is real text in the DOM but visually blurred - it is
  // random, so blur is aesthetic, not a security control (never rely on CSS
  // blur to hide real secrets).
  body.style.cssText =
    'font-family:monospace;font-size:12px;line-height:1.5;color:#3a4a46;filter:blur(2px);user-select:none;word-break:break-all';
  const lineCount = 1 + ((Math.random() * 3) | 0);
  for (let i = 0; i < lineCount; i++) {
    const line = document.createElement('div');
    line.textContent = cipherLine(28 + ((Math.random() * 40) | 0));
    body.appendChild(line);
  }
  row.appendChild(body);
  return row;
}

const LOCK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8be4d9" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

export interface LockedPreview {
  el: HTMLElement;
}

/**
 * Build the locked-preview panel. Caller mounts it (e.g. replacing the message
 * area) and does NOT connect to a relay - this is the no-identity landing.
 */
export function createLockedPreview(): LockedPreview {
  const el = document.createElement('div');
  el.style.cssText =
    'position:relative;height:100%;overflow:hidden;display:flex;flex-direction:column;background:#0a0a0a';

  // Decorative ciphertext backdrop.
  const backdrop = document.createElement('div');
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.style.cssText = 'flex:1;overflow:hidden;padding:16px 20px;opacity:0.55';
  for (const label of ['#zitadel', '#dev', '#support', '#zcash', '#pro-lounge']) {
    backdrop.appendChild(cipherRow(label));
    backdrop.appendChild(cipherRow(label));
  }
  el.appendChild(backdrop);

  // Foreground gate: fades over the backdrop with the message + CTA.
  const gate = document.createElement('div');
  gate.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;background:linear-gradient(to bottom,rgba(10,10,10,0.35),rgba(10,10,10,0.85))';

  const lock = document.createElement('div');
  lock.innerHTML = LOCK_SVG;
  lock.style.cssText = 'margin-bottom:12px';
  gate.appendChild(lock);

  const h = document.createElement('div');
  h.textContent = 'the citadel is encrypted';
  h.style.cssText = 'color:#e6e6e6;font-size:18px;font-weight:600;margin-bottom:8px';
  gate.appendChild(h);

  const p = document.createElement('div');
  p.textContent =
    'messages here are end-to-end encrypted between ZIDs. get zafu to create your ZID and unlock the channels.';
  p.style.cssText = 'color:#9a9a9a;font-size:13px;max-width:340px;line-height:1.5;margin-bottom:18px';
  gate.appendChild(p);

  const cta = document.createElement('a');
  cta.href = ZAFU_DOWNLOAD_URL;
  cta.target = '_blank';
  cta.rel = 'noopener noreferrer';
  cta.textContent = 'download zafu -> zafu.pro';
  cta.style.cssText =
    'display:inline-block;padding:10px 18px;border:1px solid #8be4d9;border-radius:8px;color:#8be4d9;text-decoration:none;font-size:14px;font-weight:600';
  cta.onmouseenter = () => {
    cta.style.background = '#8be4d9';
    cta.style.color = '#0a0a0a';
  };
  cta.onmouseleave = () => {
    cta.style.background = 'transparent';
    cta.style.color = '#8be4d9';
  };
  gate.appendChild(cta);

  const note = document.createElement('div');
  note.textContent = 'preview - the text above is a decorative lock, not real messages';
  note.style.cssText = 'color:#555;font-size:10px;margin-top:14px';
  gate.appendChild(note);

  el.appendChild(gate);
  return { el };
}
