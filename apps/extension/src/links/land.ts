/**
 * Where a link lands: one screen per intent, the user's own review on it.
 * A landing never signs, sends, approves or changes a setting; it only opens
 * a screen, filled in. What zafu can't do yet gets one calm line instead.
 */

import { PopupPath } from '../routes/popup/paths';
import { getSubnetworks } from '../config/networks';
import { notYet, SCREENS, toUri, type Intent, type Parsed, type SwapLink } from './router';

/** how a link reached zafu: a site's origin (stamped by the service worker) or one of these */
const VIA_WORDS: Record<string, string> = {
  pasted: 'link pasted',
  scanned: 'link scanned',
  message: 'link from a message',
  typed: 'typed in the address bar',
};

/** the quiet line a review shows about where its link came from */
export const viaLine = (via: string | null | undefined): string | undefined => {
  if (!via) {
    return undefined;
  }
  if (Object.hasOwn(VIA_WORDS, via)) {
    return VIA_WORDS[via];
  }
  try {
    const url = new URL(via);
    return /^https?:$/.test(url.protocol) ? `link from ${url.host}` : undefined;
  } catch {
    return undefined;
  }
};

/** route state the swap screen accepts from a link */
export interface SwapLinkState {
  link: SwapLink;
  via?: string;
}

export type Landing = { to: string; state?: unknown } | { line: string };

const withVia = (via: string | undefined) => (via ? `&via=${encodeURIComponent(via)}` : '');

const LAND: { [K in Intent['kind']]: (i: Extract<Intent, { kind: K }>, via?: string) => Landing } =
  {
    pay: (i, via) => ({
      to: `${PopupPath.SEND}?to=${encodeURIComponent(toUri(i))}${withVia(via)}`,
    }),
    swap: (i, via) => ({
      to: PopupPath.SWAP,
      state: { link: i.swap, via } satisfies SwapLinkState,
    }),
    move: ({ move: m }) =>
      m.action === 'swap'
        ? { to: PopupPath.SWAP, state: { prefillFromAsset: m.asset } }
        : m.action === 'shield'
          ? getSubnetworks('penumbra').includes(m.chain)
            ? {
                to: PopupPath.SEND,
                state: {
                  cosmosChain: m.chain,
                  cosmosAccountIndex: m.index,
                  cosmosIntent: 'shield',
                },
              }
            : { line: "zafu can't shield from that chain" }
          : {
              to: PopupPath.SEND,
              state: {
                network: 'penumbra',
                prefillAsset: m.asset,
                ...(m.action === 'unshield' ? { penumbraMode: 'withdraw' } : {}),
              },
            },
    screen: i => ({ to: SCREENS[i.screen] }),
    // the query, not route state, so the card survives the unlock redirect
    contact: (i, via) => ({
      to: `${PopupPath.CONTACT_CARD}?card=${encodeURIComponent(i.card)}${withVia(via)}`,
    }),
    // the query, so the code survives the unlock redirect
    join: (i, via) => ({
      to: `${PopupPath.INBOX_JOIN}?code=${encodeURIComponent(i.code)}${withVia(via)}`,
    }),
  };

export const land = (parsed: Parsed, via?: string): Landing => {
  if (!parsed.ok) {
    return { line: parsed.reason };
  }
  const later = notYet(parsed.intent);
  return later
    ? { line: later }
    : (LAND[parsed.intent.kind] as (i: Intent, via?: string) => Landing)(parsed.intent, via);
};
