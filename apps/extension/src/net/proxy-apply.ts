/**
 * The service worker's half of the person's proxy (./proxy): keep Chrome's
 * PAC script in step with the egress table, and answer the proxy's login.
 *
 * Both need permissions the person grants when they turn the proxy on
 * (`proxy`, and for a login `webRequest` + `webRequestAuthProvider`); until
 * then the APIs are absent and this does nothing. The login listener is
 * registered at the worker's start when the permission is there, so the
 * event can wake the worker, and again the moment the permission is granted.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted } from '../state/encrypted-storage';
import { compileEgress, EGRESS_INPUT_KEYS, type EgressInputs } from './egress-policy';
import { hostOf } from './destination';
import { PRIME_PROXY, primerUrl } from './proxy-primer';
import { ensureOffscreenDocument } from '../offscreen-document';
import {
  isProxyLogin,
  pacFor,
  PROXY_APPLIED_KEY,
  PROXY_KEY,
  PROXY_LOGIN_KEY,
  type ProxyApplied,
  proxyAnswer,
  proxyHosts,
  proxyInUse,
} from './proxy';

const keys = new Set<string>(EGRESS_INPUT_KEYS);

/** what the policy reads to fail closed; written only when it changes */
const noteApplied = async (v: ProxyApplied | undefined): Promise<void> => {
  const now = (await chrome.storage.local.get(PROXY_APPLIED_KEY))[PROXY_APPLIED_KEY];
  if (now === v) {
    return;
  }
  await (v === undefined
    ? chrome.storage.local.remove(PROXY_APPLIED_KEY)
    : chrome.storage.local.set({ [PROXY_APPLIED_KEY]: v }));
};

const control = () =>
  new Promise<chrome.types.ChromeSettingGetResultDetails>(r => chrome.proxy.settings.get({}, r));

/**
 * Set the PAC for zafu's hosts, or take back a proxy zafu set (another
 * extension's is left alone), and note whether it holds: the policy refuses
 * zafu's traffic while a chosen proxy isn't applied.
 */
export const applyProxy = async (): Promise<void> => {
  const inputs = (await chrome.storage.local.get([...EGRESS_INPUT_KEYS])) as EgressInputs;
  const p = proxyInUse(inputs.netProxy);
  if (!chrome.proxy?.settings) {
    return noteApplied(p ? 'no-permission' : undefined);
  }
  if (!p) {
    if ((await control()).levelOfControl === 'controlled_by_this_extension') {
      await chrome.proxy.settings.clear({ scope: 'regular' });
    }
    return noteApplied(undefined);
  }
  await chrome.proxy.settings.set({
    value: {
      mode: 'pac_script',
      // mandatory: a script Chrome can't run fails the request rather than going direct
      pacScript: { data: pacFor(p, proxyHosts(compileEgress(inputs))), mandatory: true },
    },
    scope: 'regular',
  });
  const held = (await control()).levelOfControl === 'controlled_by_this_extension';
  // a login with no hook to give it: the proxy would refuse everything, unexplained
  const loginUnanswerable =
    p.kind !== 'socks5' &&
    !listenForLogin() &&
    (await chrome.storage.local.get(PROXY_LOGIN_KEY))[PROXY_LOGIN_KEY] !== undefined;
  await noteApplied(!held ? 'other-extension' : loginUnanswerable ? 'no-permission' : 'ok');
  if (held) {
    void primeProxy(inputs);
  }
};

/**
 * Give the proxy its login once, from a frame, so zafu's own requests carry
 * it (./proxy-primer). Only an HTTP(S) proxy with a login, only while the
 * login can be read; to the zcash node when it goes through the proxy.
 */
export const primeProxy = async (inputs?: EgressInputs): Promise<void> => {
  const i = inputs ?? ((await chrome.storage.local.get([...EGRESS_INPUT_KEYS])) as EgressInputs);
  const p = proxyInUse(i.netProxy);
  if (!p || p.kind === 'socks5' || !(await readLogin())) {
    return;
  }
  const hosts = proxyHosts(compileEgress(i));
  const node = hostOf(i.networkEndpoints?.['zcash'] ?? 'https://zcash.rotko.net');
  const host = node && hosts.includes(node) ? node : hosts[0];
  if (!host) {
    return;
  }
  await ensureOffscreenDocument().catch(() => undefined);
  await chrome.runtime
    .sendMessage({ type: PRIME_PROXY, url: primerUrl(host) })
    .catch(() => undefined);
};

/** the sealed login: readable only while unlocked */
const readLogin = async () => {
  const login = await readEncrypted<unknown>(
    localExtStorage,
    sessionExtStorage,
    PROXY_LOGIN_KEY as never,
  ).catch(() => undefined);
  return isProxyLogin(login) ? login : undefined;
};

/** requests whose proxy login was given once: a second ask means it was refused */
const answered = new Set<string>();

const answerLogin = (
  details: chrome.webRequest.WebAuthenticationChallengeDetails,
  respond?: (r: chrome.webRequest.BlockingResponse) => void,
) => {
  void (async () => {
    const p = proxyInUse((await chrome.storage.local.get(PROXY_KEY))[PROXY_KEY]);
    // sealed: readable only while unlocked, so a locked zafu logs in to nothing
    const again = answered.has(details.requestId);
    answered.add(details.requestId);
    if (answered.size > 512) {
      answered.delete(answered.values().next().value!);
    }
    respond?.(proxyAnswer(details, p, await readLogin(), again));
  })();
};

/**
 * Listen for the proxy's login, and say whether zafu is listening. `webRequest`
 * alone (a Peer buy grants it) exposes the event, but a blocking listener also
 * needs `webRequestAuthProvider`, and Chrome throws without it. That throw ran
 * at the worker's top level and stopped everything after it, passkeys included.
 */
const listenForLogin = (): boolean => {
  const ev = chrome.webRequest?.onAuthRequired;
  if (!ev) {
    return false;
  }
  try {
    if (!ev.hasListener(answerLogin)) {
      ev.addListener(answerLogin, { urls: ['<all_urls>'] }, ['asyncBlocking']);
    }
    return ev.hasListener(answerLogin);
  } catch {
    return false;
  }
};

/** call at the worker's top level, synchronously */
export const startProxy = (): void => {
  listenForLogin();
  chrome.permissions.onAdded.addListener(() => {
    listenForLogin();
    void applyProxy();
  });
  // a permission taken back: the policy then refuses, it never goes direct
  chrome.permissions.onRemoved.addListener(() => void applyProxy());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => keys.has(k) || k === PROXY_LOGIN_KEY)) {
      void applyProxy();
    }
    // an unlock: the login can be read again, so the proxy gets it again
    if (area === 'session' && changes['passwordKey']?.newValue) {
      void primeProxy();
    }
  });
  void applyProxy();
};
