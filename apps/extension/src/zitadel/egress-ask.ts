/**
 * The ask-at-the-moment sheet, vanilla DOM to match main.tsx (zitadel has no
 * framework). Same contract as net/egress-ask-sheet.tsx: installs the asker,
 * shows one row at the bottom of the page per request, resolves on answer.
 */

import { setEgressAsker } from '../net/egress-opt-in';
import type { DestinationView } from '../net/egress-policy';

const GOLD = '#c9a86a';

/** host zafu would contact for this destination - the ask copy names it. */
const destinationHost = (view: DestinationView): string => view.hosts[0] ?? view.label;

export function installEgressAskSheet(): () => void {
  return setEgressAsker(
    view =>
      new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.7)';

        const sheet = document.createElement('div');
        sheet.style.cssText =
          'width:100%;max-width:420px;border-top:1px solid #333;background:#111;padding:16px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:#ddd';

        const text = document.createElement('p');
        text.style.cssText = 'margin:0;color:#aaa;text-transform:lowercase';
        text.textContent = `${view.label} needs to talk to ${destinationHost(view)} - zafu hasn't contacted it before.`;
        sheet.appendChild(text);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px';
        sheet.appendChild(row);

        const settle = (allow: boolean): void => {
          document.body.removeChild(overlay);
          resolve(allow);
        };

        const notNow = document.createElement('button');
        notNow.textContent = 'not now';
        notNow.style.cssText =
          'flex:1;height:36px;border:1px solid #333;background:#161616;color:#ddd;cursor:pointer';
        notNow.onclick = () => settle(false);
        row.appendChild(notNow);

        const allow = document.createElement('button');
        allow.textContent = 'allow';
        allow.style.cssText = `flex:1;height:36px;border:0;background:${GOLD};color:#111;cursor:pointer`;
        allow.onclick = () => settle(true);
        row.appendChild(allow);

        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
      }),
  );
}
