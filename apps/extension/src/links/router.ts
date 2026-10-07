/**
 * Every link zafu understands, read in one place: `zcash:` payment requests
 * (ZIP 321, so any zcash wallet can open them), `zafu:` intents for what only
 * zafu does, and the zafu.pro web forms of the social ones.
 *
 * Pure and table-driven: a link becomes an Intent or a calm refusal, and an
 * Intent becomes a link again for sharing. A link only ever describes; the
 * screen it lands on shows everything and the user confirms there.
 *
 * Bundled into the links content script, so it imports nothing heavy.
 */

import {
  buildZip321,
  isZip321Uri,
  parseZip321,
  type Zip321Payment,
} from '@repo/wallet/networks/zcash/zip321';
import { PopupPath } from '../routes/popup/paths';
import { isRouteId, ROUTES, type RouteId } from '../state/swap/routes';

export interface SwapLink {
  direction: 'into_zec' | 'from_zec';
  /** the other side's token symbol, lowercase */
  token: string;
  /** the other side's chain, when the symbol lives on several */
  chain?: string;
  /** decimal, in the asset being sent */
  amount?: string;
  /** into zec: the payer's refund address; from zec: where the token goes */
  address?: string;
  /** `xc=`: the one route to quote, when the link pins it */
  route?: RouteId;
}

/** in-app screens a link may open: names, never paths taken from the link */
export const SCREENS = {
  receive: PopupPath.RECEIVE,
  activity: PopupPath.ACTIVITY,
  contacts: PopupPath.CONTACTS,
  inbox: PopupPath.INBOX,
  swap: PopupPath.SWAP,
  vote: PopupPath.VOTE,
  identity: PopupPath.IDENTITY,
  settings: PopupPath.SETTINGS,
  'settings/networks': PopupPath.SETTINGS_NETWORKS,
  'settings/networks/zcash': PopupPath.SETTINGS_ZCASH_NETWORK,
  'settings/networks/penumbra': PopupPath.SETTINGS_PENUMBRA_NETWORK,
  'settings/privacy': PopupPath.SETTINGS_PRIVACY,
  'settings/security': PopupPath.SETTINGS_SECURITY,
  'settings/about': PopupPath.SETTINGS_ABOUT,
} as const;

export type Screen = keyof typeof SCREENS;

/** one asset moved within the wallet: its row's own actions, one route each */
export type Move =
  | { action: 'send' | 'unshield' | 'swap'; asset: string }
  | { action: 'shield'; chain: string; index: number };

export type Intent =
  | { kind: 'pay'; payments: Zip321Payment[] }
  | { kind: 'move'; move: Move }
  | { kind: 'swap'; swap: SwapLink }
  | { kind: 'screen'; screen: Screen }
  | { kind: 'contact'; card: string }
  | { kind: 'join'; code: string };

export type Parsed = { ok: true; intent: Intent } | { ok: false; reason: string };

const MAX_LINK = 4096;
const UNREADABLE = "this link can't be read, sorry";
/** bidi overrides and invisible marks can make text read as something else; the joiners (U+200C, U+200D) stay, scripts and emoji need them */
const HIDDEN = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
// eslint-disable-next-line no-control-regex -- the point is to find them
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex -- a memo may keep its line breaks
const MEMO_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const SYMBOL = /^[a-z0-9]{1,12}$/;
const CHAIN = /^[a-z0-9]{1,16}$/;
/** chain addresses across the swap service: ascii, no spaces, no markup */
const FOREIGN_ADDRESS = /^[A-Za-z0-9._:-]{3,128}$/;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,18}))?$/;
/** a door code (`7-fern-dusk`), or an older zafu's four-part one, read so the join screen can say so */
const ROOM_CODE = /^\d{1,3}(?:-[a-z]{2,12}){2,3}$/;
const CARD = /^[A-Za-z0-9_-]{16,2048}$/;
/** a penumbra base denom: `upenumbra`, `transfer/channel-4/uusdc`, ... */
const DENOM = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,127}$/;
const INDEX = /^\d{1,9}$/;
const MAX_ZEC = 21_000_000;

const refuse = (reason: string): Parsed => ({ ok: false, reason });
const accept = (intent: Intent): Parsed => ({ ok: true, intent });

/** query string -> unique lowercase params; refuses duplicates and required unknowns */
const readQuery = (
  query: string,
  known: readonly string[],
): { ok: true; params: Map<string, string> } | { ok: false; reason: string } => {
  const params = new Map<string, string>();
  for (const pair of query ? query.split('&') : []) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf('=');
    const name = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!known.includes(name)) {
      if (name.startsWith('req-')) {
        return { ok: false, reason: "this link asks for something zafu doesn't know yet" };
      }
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
    } catch {
      return { ok: false, reason: UNREADABLE };
    }
    if (params.has(name)) {
      return { ok: false, reason: UNREADABLE };
    }
    params.set(name, value);
  }
  return { ok: true, params };
};

const payText = (p: Zip321Payment): boolean =>
  [p.label, p.message].every(t => t === undefined || !(CONTROL.test(t) || HIDDEN.test(t))) &&
  (p.memo === undefined || !(MEMO_CONTROL.test(p.memo) || HIDDEN.test(p.memo)));

const readPay = (uri: string): Parsed => {
  const r = parseZip321(uri);
  if (!r.ok) {
    return refuse(`${UNREADABLE} · ${r.error}`);
  }
  if (!r.payments.every(payText)) {
    return refuse('this link carries hidden characters · zafu leaves it unopened');
  }
  return accept({ kind: 'pay', payments: r.payments });
};

const readAmount = (text: string | undefined, zec: boolean): string | undefined | false => {
  if (text === undefined || text === '') {
    return undefined;
  }
  const m = AMOUNT.exec(text);
  if (!m || !/[1-9]/.test(text) || (zec && ((m[2]?.length ?? 0) > 8 || Number(m[1]) > MAX_ZEC))) {
    return false;
  }
  return text;
};

/** `zafu:send|unshield?asset=`: one of the wallet's own assets */
const readAssetMove =
  (action: 'send' | 'unshield' | 'swap') =>
  (arg: string, query: string): Parsed => {
    const q = readQuery(query, ['asset']);
    if (!q.ok) {
      return refuse(q.reason);
    }
    const asset = q.params.get('asset');
    return !arg && asset && DENOM.test(asset)
      ? accept({ kind: 'move', move: { action, asset } })
      : refuse(UNREADABLE);
  };

/** `zafu:shield?chain=&index=`: a deposit address's funds, into penumbra */
const readShield = (arg: string, query: string): Parsed => {
  const q = readQuery(query, ['chain', 'index']);
  if (!q.ok) {
    return refuse(q.reason);
  }
  const chain = q.params.get('chain')?.toLowerCase();
  const index = q.params.get('index') ?? '0';
  return !arg && chain && CHAIN.test(chain) && INDEX.test(index)
    ? accept({ kind: 'move', move: { action: 'shield', chain, index: Number(index) } })
    : refuse(UNREADABLE);
};

const readSwap = (query: string): Parsed => {
  const q = readQuery(query, [
    'from',
    'to',
    'into',
    'amount',
    'refund',
    'dest',
    'chain',
    'xc',
    'asset',
  ]);
  if (!q.ok) {
    return refuse(q.reason);
  }
  const p = q.params;
  // `asset=` alone: a swap on penumbra's dex, from one of the wallet's assets
  if (p.has('asset')) {
    return p.size === 1
      ? readAssetMove('swap')('', `asset=${encodeURIComponent(p.get('asset')!)}`)
      : refuse(UNREADABLE);
  }
  if (p.has('to') && p.has('into')) {
    return refuse(UNREADABLE);
  }
  const from = p.get('from')?.toLowerCase();
  const to = (p.get('to') ?? p.get('into'))?.toLowerCase();
  const direction = from === 'zec' ? 'from_zec' : to === 'zec' ? 'into_zec' : undefined;
  const token = direction === 'from_zec' ? to : from;
  if (!direction || !token || token === 'zec' || !SYMBOL.test(token)) {
    return refuse('a swap link pairs zec with one other token');
  }
  const chain = p.get('chain')?.toLowerCase();
  if (chain !== undefined && !CHAIN.test(chain)) {
    return refuse(UNREADABLE);
  }
  // into zec, the zec lands in this wallet; from zec, a refund returns here
  const [addrKey, wrongKey] = direction === 'into_zec' ? ['refund', 'dest'] : ['dest', 'refund'];
  if (p.has(wrongKey)) {
    return refuse(
      direction === 'into_zec'
        ? 'zec from a swap always lands in your own wallet'
        : 'a refund for zec always returns to your own wallet',
    );
  }
  const address = p.get(addrKey) || undefined;
  if (address !== undefined && !FOREIGN_ADDRESS.test(address)) {
    return refuse('please check the address in this link · it looks unusual');
  }
  const amount = readAmount(p.get('amount'), direction === 'from_zec');
  if (amount === false) {
    return refuse('please check the amount in this link · it looks unusual');
  }
  const route = p.get('xc')?.toLowerCase() || undefined;
  if (route !== undefined && !isRouteId(route)) {
    return refuse("this link names a swap route zafu doesn't know");
  }
  const swap: SwapLink = { direction, token };
  if (route) {
    swap.route = route;
  }
  if (chain) {
    swap.chain = chain;
  }
  if (amount) {
    swap.amount = amount;
  }
  if (address) {
    swap.address = address;
  }
  return accept({ kind: 'swap', swap });
};

const readJoin = (code: string): Parsed =>
  ROOM_CODE.test(code) ? accept({ kind: 'join', code }) : refuse(UNREADABLE);

const readContact = (card: string): Parsed =>
  CARD.test(card) ? accept({ kind: 'contact', card }) : refuse(UNREADABLE);

/** `zafu:<verb>[/<arg>][?query][#fragment]`, one reader per verb */
const VERBS: Record<string, (arg: string, query: string, fragment: string) => Parsed> = {
  swap: (arg, query) => (arg ? refuse(UNREADABLE) : readSwap(query)),
  open: arg =>
    Object.hasOwn(SCREENS, arg)
      ? accept({ kind: 'screen', screen: arg as Screen })
      : refuse("zafu can't open that screen from a link"),
  contact: (arg, _q, fragment) => (arg ? refuse(UNREADABLE) : readContact(fragment)),
  join: arg => readJoin(arg),
  send: readAssetMove('send'),
  unshield: readAssetMove('unshield'),
  shield: readShield,
};

const readZafu = (rest: string): Parsed => {
  const hash = rest.indexOf('#');
  const fragment = hash === -1 ? '' : rest.slice(hash + 1);
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash);
  const q = beforeHash.indexOf('?');
  const path = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const query = q === -1 ? '' : beforeHash.slice(q + 1);
  // the path is ascii words and slashes only: no `//`, dots, escapes or traversal
  if (!/^[a-z]+(?:\/[a-z0-9-]+)*$/.test(path)) {
    return refuse(UNREADABLE);
  }
  const slash = path.indexOf('/');
  const verb = slash === -1 ? path : path.slice(0, slash);
  const reader = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  return reader
    ? reader(slash === -1 ? '' : path.slice(slash + 1), query, fragment)
    : refuse("zafu doesn't know this kind of link yet");
};

/** zafu.pro/<x>#<payload>: the payload stays after the `#`, never sent to the site */
const WEB: Record<string, (payload: string) => Parsed> = { j: readJoin, c: readContact };

const readWeb = (text: string): Parsed => {
  const m = /^https:\/\/(?:www\.)?zafu\.pro\/([a-z])\/?#(.*)$/.exec(text);
  const reader = m?.[1] && Object.hasOwn(WEB, m[1]) ? WEB[m[1]] : undefined;
  return reader && m ? reader(m[2] ?? '') : refuse("zafu doesn't know this kind of link yet");
};

/** one reader per scheme */
const SCHEMES: [test: RegExp, read: (text: string) => Parsed][] = [
  [/^zcash:/i, readPay],
  [
    /^zafu:/i,
    text => (text.slice(5).startsWith('/') ? refuse(UNREADABLE) : readZafu(text.slice(5))),
  ],
  [/^https:\/\//i, readWeb],
];

export const parseLink = (uri: string): Parsed => {
  const text = uri.trim();
  if (text.length > MAX_LINK) {
    return refuse('this link is too long to be safe · zafu leaves it unopened');
  }
  if (HIDDEN.test(text) || CONTROL.test(text)) {
    return refuse('this link carries hidden characters · zafu leaves it unopened');
  }
  const scheme = SCHEMES.find(([test]) => test.test(text));
  return scheme ? scheme[1](text) : refuse("zafu doesn't know this kind of link yet");
};

/** text that might be a link (so a form hands it to the router instead of keeping it) */
export const looksLikeLink = (text: string): boolean =>
  isZip321Uri(text) ||
  /^zafu:/i.test(text.trim()) ||
  /^https:\/\/(www\.)?zafu\.pro\//i.test(text.trim());

/**
 * An intent zafu reads but can't act on yet. Refused here, before any screen,
 * so a clicked `zcash:` link zafu can't pay still reaches the system's wallet.
 */
export const notYet = (intent: Intent): string | undefined =>
  intent.kind === 'pay' && intent.payments.length > 1
    ? `this request pays ${intent.payments.length} addresses · zafu pays one at a time, for now`
    : intent.kind === 'swap' && intent.swap.route
      ? ROUTES[intent.swap.route].refuses({
          direction: intent.swap.direction,
          symbol: intent.swap.token,
          chain: intent.swap.chain,
        })
      : undefined;

const swapUri = ({ direction, token, chain, amount, address, route }: SwapLink): string => {
  const into = direction === 'into_zec';
  const params: [string, string | undefined][] = [
    ['from', into ? token : 'zec'],
    ['to', into ? 'zec' : token],
    ['chain', chain],
    ['amount', amount],
    [into ? 'refund' : 'dest', address],
    ['xc', route],
  ];
  return `zafu:swap?${params
    .filter((e): e is [string, string] => !!e[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')}`;
};

const moveUri = (m: Move): string =>
  m.action === 'shield'
    ? `zafu:shield?chain=${encodeURIComponent(m.chain)}&index=${m.index}`
    : `zafu:${m.action}?asset=${encodeURIComponent(m.asset)}`;

const TO_URI: { [K in Intent['kind']]: (i: Extract<Intent, { kind: K }>) => string } = {
  pay: i => buildZip321(i.payments),
  move: i => moveUri(i.move),
  swap: i => swapUri(i.swap),
  screen: i => `zafu:open/${i.screen}`,
  contact: i => `zafu:contact#${i.card}`,
  join: i => `zafu:join/${i.code}`,
};

export const toUri = (intent: Intent): string =>
  (TO_URI[intent.kind] as (i: Intent) => string)(intent);

/** the zafu.pro form of a social link, for anyone without zafu; the inverse of `WEB` */
export const toWebUri = (intent: Extract<Intent, { kind: 'contact' | 'join' }>): string =>
  intent.kind === 'contact'
    ? `https://zafu.pro/c#${intent.card}`
    : `https://zafu.pro/j#${intent.code}`;
