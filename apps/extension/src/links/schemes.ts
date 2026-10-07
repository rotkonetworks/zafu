import type { PrivacySettings } from '../state/privacy';

/** the message a links content script sends the service worker */
export const OPEN_LINK = 'zafu_open_link';

export type LinkSetting = keyof Pick<PrivacySettings, 'openZcashLinks' | 'openZafuLinks'>;

/**
 * Link schemes a click on a page may hand to zafu, each behind its own
 * setting. `ownsMalformed`: no other app opens this scheme, so zafu answers
 * even a link it can't read, instead of leaving the click to the browser.
 */
export const SCHEMES: readonly { test: RegExp; setting: LinkSetting; ownsMalformed: boolean }[] = [
  { test: /^zcash:/i, setting: 'openZcashLinks', ownsMalformed: false },
  { test: /^zafu:/i, setting: 'openZafuLinks', ownsMalformed: true },
  // a card or group link's web form: the site itself answers one zafu can't read
  {
    test: /^https:\/\/(?:www\.)?zafu\.pro\/[cj]\/?#/i,
    setting: 'openZafuLinks',
    ownsMalformed: false,
  },
];
