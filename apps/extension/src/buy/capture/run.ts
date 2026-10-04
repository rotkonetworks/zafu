/**
 * zafu as the capture extension (docs.peer.xyz/developer/build-your-own-extension),
 * run from the buy page itself: the page opens the payment app in a tab,
 * watches only that tab's requests to the app's own hosts, reads the payment
 * list once, seals the matching request for Peer's verifier, closes the tab
 * and forgets everything. Nothing is persisted; the plaintext lives in this
 * page's memory for the seconds it takes.
 *
 * The page, not the service worker, holds the listeners, so there is no
 * worker lifetime to outlive and no message hop for the session material.
 *
 * Permissions: webRequest (to see the request and its headers) and scripting
 * (to replay a request inside the app's own page, for apps whose templates
 * ask for that) are optional, requested inside the person's tap, and given
 * back when the capture ends unless they chose to keep them.
 *
 * Hosts: the required `<all_urls>` host permission (the service worker
 * reaches whatever light-client endpoint the person configures) already
 * covers every pay app's hosts, so they are not optional_host_permissions
 * (Chrome warns they are redundant and drops them) and are never requested.
 */

import type { PayApp, TemplateKey } from '../apps';
import {
  extractRows,
  isPaymentRequest,
  matchingRows,
  replayOf,
  sessionMaterial,
  watchPatterns,
  type Row,
  type Seen,
  type Template,
} from './template';

export const CAPTURE_PERMISSIONS: chrome.runtime.ManifestPermissions[] = [
  'webRequest',
  'scripting',
];

const originsOf = (app: PayApp) => app.hosts.map(h => `https://${h}/*`);

/** the app's hosts ride on the required `<all_urls>`, so only the APIs are asked for */
export const hasCaptureAccess = (): Promise<boolean> =>
  chrome.permissions.contains({ permissions: CAPTURE_PERMISSIONS });

/** must run inside the person's tap: Chrome only grants from a user gesture */
export const requestCaptureAccess = (): Promise<boolean> =>
  chrome.permissions.request({ permissions: CAPTURE_PERMISSIONS });

/** give the access back (the origins stay as zafu's install granted them) */
export const releaseCaptureAccess = (): Promise<boolean> =>
  chrome.permissions.remove({ permissions: CAPTURE_PERMISSIONS }).catch(() => false);

export type CaptureStep = 'opened' | 'seen' | 'found' | 'sealing';

export type Captured =
  | { kind: 'found'; rows: Row[]; seen: Seen }
  | { kind: 'none'; rows: Row[] }
  | { kind: 'closed' };

/** fetch inside the app's own page (MAIN world: the app's cookies, never zafu's guard) */
const replayInPage = async (tabId: number, s: Seen): Promise<string> => {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [{ url: s.url, method: s.method, body: s.body ?? null, headers: s.headers }],
    func: async (r: {
      url: string;
      method: string;
      body: string | null;
      headers: { name: string; value?: string }[];
    }) => {
      const skip =
        /^(host|cookie|content-length|user-agent|origin|referer|connection|accept-encoding|sec-.*)$/i;
      const h = new Headers();
      for (const x of r.headers) {
        if (x.value && !skip.test(x.name)) {
          h.append(x.name, x.value);
        }
      }
      const resp = await fetch(r.url, {
        method: r.method,
        headers: h,
        credentials: 'include',
        body: r.method === 'GET' || r.method === 'HEAD' ? undefined : (r.body ?? undefined),
      });
      return resp.text();
    },
  });
  return String(res?.result ?? '');
};

/** fetch from this page with the captured headers (the app host is allowed at the tap) */
const replayHere = async (s: Seen): Promise<string> => {
  const headers: Record<string, string> = {};
  for (const x of s.headers) {
    if (x.value) {
      headers[x.name] = x.value;
    }
  }
  const resp = await fetch(s.url, {
    method: s.method,
    headers,
    credentials: 'include',
    body: s.method === 'GET' || s.method === 'HEAD' ? undefined : s.body,
  });
  return resp.text();
};

/**
 * Open the app, wait for its payment list, and return the rows that match
 * this payment. Resolves 'closed' when the person closes the tab, 'none'
 * when the list came back without it (or `timeoutMs` passed).
 */
export const capturePayment = (p: {
  app: PayApp;
  template: Template;
  expect: { fiat: number; currency: string; handle: string };
  onStep: (s: CaptureStep) => void;
  timeoutMs?: number;
}): Promise<Captured> =>
  new Promise((resolve, reject) => {
    const filter: chrome.webRequest.RequestFilter = {
      urls: originsOf(p.app),
      types: ['xmlhttprequest', 'main_frame'],
    };
    const patterns = watchPatterns(p.template);
    const seen = new Map<string, Seen>();
    let tabId = -1;
    let busy = false;
    let last: Row[] = [];

    const done = (r: Captured) => {
      clearTimeout(timer);
      chrome.webRequest.onBeforeRequest.removeListener(onBody);
      chrome.webRequest.onSendHeaders.removeListener(onHeaders);
      chrome.webRequest.onResponseStarted.removeListener(onResponse);
      chrome.tabs.onRemoved.removeListener(onClosed);
      seen.clear();
      if (r.kind !== 'closed' && tabId >= 0) {
        void chrome.tabs.remove(tabId).catch(() => undefined);
      }
      resolve(r);
    };
    const mine = (d: { tabId: number; url: string; initiator?: string }) =>
      d.tabId === tabId &&
      !d.initiator?.includes(chrome.runtime.id) &&
      patterns.some(r => r.test(d.url));

    const onBody = (d: chrome.webRequest.WebRequestBodyDetails) => {
      if (mine(d) && !busy) {
        const bytes = d.requestBody?.raw?.[0]?.bytes;
        const form = d.requestBody?.formData;
        const body = bytes
          ? new TextDecoder().decode(bytes)
          : form
            ? new URLSearchParams(
                Object.entries(form).flatMap(([k, vs]) => vs.map(v => [k, v])),
              ).toString()
            : undefined;
        seen.set(d.requestId, { url: d.url, method: d.method, headers: [], body });
      }
      return undefined;
    };
    const onHeaders = (d: chrome.webRequest.WebRequestHeadersDetails) => {
      if (mine(d) && !busy) {
        const prev = seen.get(d.requestId);
        seen.set(d.requestId, {
          url: d.url,
          method: d.method,
          body: prev?.body,
          headers: d.requestHeaders ?? [],
        });
      }
    };
    const onResponse = (d: chrome.webRequest.WebResponseCacheDetails) => {
      const s = seen.get(d.requestId);
      seen.delete(d.requestId);
      if (
        !s ||
        busy ||
        d.statusCode < 200 ||
        d.statusCode >= 300 ||
        !isPaymentRequest(s, p.template)
      ) {
        return;
      }
      busy = true;
      p.onStep('seen');
      const replay = replayOf(s, p.template);
      void (
        p.template.metadata.shouldReplayRequestInPage
          ? replayInPage(tabId, replay)
          : replayHere(replay)
      )
        .then(body => {
          last = extractRows(p.template, replay, body);
          const rows = matchingRows(last, p.expect);
          if (rows.length) {
            p.onStep('found');
            // the verifier replays what was read: the replay request, captured headers
            done({ kind: 'found', rows, seen: replay });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const onClosed = (id: number) => {
      if (id === tabId) {
        done({ kind: 'closed' });
      }
    };

    const timer = setTimeout(() => done({ kind: 'none', rows: last }), p.timeoutMs ?? 3 * 60_000);
    chrome.webRequest.onBeforeRequest.addListener(onBody, filter, ['requestBody']);
    chrome.webRequest.onSendHeaders.addListener(onHeaders, filter, [
      'requestHeaders',
      'extraHeaders',
    ]);
    chrome.webRequest.onResponseStarted.addListener(onResponse, filter);
    chrome.tabs.onRemoved.addListener(onClosed);
    void chrome.tabs
      .create({ url: p.template.authLink, active: true })
      .then(t => {
        tabId = t.id ?? -1;
        p.onStep('opened');
      })
      .catch(e => {
        done({ kind: 'closed' });
        reject(e as Error);
      });
  });

/** the template key the verifier is told about (zelle: the bank's) */
export const templateKeyFor = (app: PayApp, bank?: TemplateKey): TemplateKey | undefined =>
  bank && app.templates.includes(bank) ? bank : app.templates[0];

export { sessionMaterial };
