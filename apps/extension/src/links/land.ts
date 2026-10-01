/**
 * Where a link lands: one screen per intent, the user's own review on it.
 * A landing never signs, sends, approves or changes a setting; it only opens
 * a screen, filled in. What zafu can't do yet gets one calm line instead.
 */

import { PopupPath } from '../routes/popup/paths';
import { notYet, SCREENS, toUri, type Intent, type Parsed, type SwapLink } from './router';

/** how a link reached zafu: a site's origin (stamped by the service worker) or one of these */
const VIA_WORDS: Record<string, string> = {
  pasted: 'link pasted',
  scanned: 'link scanned',
  message: 'link from a message',
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
    screen: i => ({ to: SCREENS[i.screen] }),
    contact: () => ({ line: 'adding a contact from a link is coming · thank you for waiting' }),
    join: () => ({ line: 'groups are coming soon · please keep the code until then' }),
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
