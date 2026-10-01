/**
 * The `zafu` omnibox keyword: typed text after the keyword reaches the same
 * router a clicked link uses, so the address bar is a third way in (besides
 * a page click and a pasted link), never a second parser.
 *
 * Text with no scheme is a bare intent path ("open/receive",
 * "swap?from=eth&to=zec&amount=1"); `zcash:`, `zafu:` and `https://` already
 * carry one and pass straight through. Nothing here executes anything - it
 * only describes, same as the review screen the intent lands on.
 */

import { describeIntent } from './describe';
import { notYet, parseLink, type Parsed } from './router';

const HAS_SCHEME = /^(?:zcash:|zafu:|https:\/\/)/i;

/** omnibox text -> a uri `parseLink` already understands */
export const omniboxUri = (text: string): string => {
  const trimmed = text.trim();
  return HAS_SCHEME.test(trimmed) ? trimmed : `zafu:${trimmed}`;
};

export const parseOmnibox = (text: string): Parsed => parseLink(omniboxUri(text));

/** one calm line for the omnibox dropdown: what pressing enter would open */
export const omniboxDescription = (text: string): string => {
  if (!text.trim()) {
    return 'open zafu';
  }
  const parsed = parseOmnibox(text);
  if (!parsed.ok) {
    return `not sure what to open · ${parsed.reason}`;
  }
  return notYet(parsed.intent) ?? describeIntent(parsed.intent);
};

/** chrome's omnibox suggestion description is a small XML dialect; escape plain text for it */
export const escapeOmniboxXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
