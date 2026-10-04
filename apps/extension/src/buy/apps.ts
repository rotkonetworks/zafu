/**
 * The payment apps a buy can use, as data. Order is the order the sheet
 * shows: the four a first-time buyer can use, then the ones that are greyed.
 * Hosts are the only places capture may read for that app; the bundled
 * templates (capture/templates.json) must stay inside them (apps.test.ts).
 */

/** a pinned template in capture/templates.json (apps.test.ts checks the keys) */
export type TemplateKey =
  | 'revolut'
  | 'wise'
  | 'monzo'
  | 'zelle_chase'
  | 'zelle_bofa'
  | 'zelle_citi';

export interface PayApp {
  /** Peer's platform name */
  id: string;
  name: string;
  mark: string;
  /** what the ask screen names */
  site: string;
  /** where capture may read, and the only origins it asks Chrome for */
  hosts: readonly string[];
  templates: readonly TemplateKey[];
  /** currencies it can pay in; absent = any Peer offers */
  currencies?: readonly string[];
  /** greyed, with this quiet reason */
  off?: string;
  via?: string;
}

export const PAY_APPS: readonly PayApp[] = [
  {
    id: 'revolut',
    name: 'revolut',
    mark: 'r',
    site: 'revolut.com',
    hosts: ['app.revolut.com'],
    templates: ['revolut'],
  },
  {
    id: 'wise',
    name: 'wise',
    mark: 'w',
    site: 'wise.com',
    hosts: ['wise.com'],
    templates: ['wise'],
  },
  {
    id: 'zelle',
    name: 'zelle',
    mark: 'z',
    site: 'your bank',
    via: 'via your bank login',
    currencies: ['usd'],
    hosts: ['secure.chase.com', 'secure.bankofamerica.com', 'online.citi.com'],
    templates: ['zelle_chase', 'zelle_bofa', 'zelle_citi'],
  },
  {
    id: 'monzo',
    name: 'monzo',
    mark: 'm',
    site: 'monzo.com',
    currencies: ['gbp'],
    hosts: ['web.monzo.com', 'internal-api.monzo.com', 'api.monzo.com'],
    templates: ['monzo'],
  },
  // new takers need 14 days of stake on these (docs.peer.xyz stake-to-take)
  {
    id: 'venmo',
    name: 'venmo',
    mark: 'v',
    site: 'venmo.com',
    hosts: [],
    templates: [],
    off: 'after your first buy',
  },
  {
    id: 'paypal',
    name: 'paypal',
    mark: 'p',
    site: 'paypal.com',
    hosts: [],
    templates: [],
    off: 'after your first buy',
  },
  {
    id: 'cashapp',
    name: 'cash app',
    mark: '$',
    site: 'cash.app',
    hosts: [],
    templates: [],
    off: 'no sellers at small amounts',
  },
];

export const payApp = (id: string | undefined): PayApp | undefined =>
  PAY_APPS.find(a => a.id === id);

/** a bank's name for the zelle template it uses */
export const ZELLE_BANKS: Record<string, string> = {
  zelle_chase: 'chase',
  zelle_bofa: 'bank of america',
  zelle_citi: 'citi',
};

/** usable in this currency right now (not greyed, pays in it) */
export const appTakes = (app: PayApp, currency: string): boolean =>
  !app.off && (!app.currencies || app.currencies.includes(currency));

/** what greys an app for this currency, if anything */
export const appNote = (app: PayApp, currency: string): string | undefined =>
  app.off ?? (appTakes(app, currency) ? undefined : `${app.currencies?.join(', ')} only`);

export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'brl', 'ars', 'inr'] as const;

const EURO = new Set('at be cy de ee es fi fr gr hr ie it lt lu lv mt nl pt si sk'.split(' '));

/** the person's likely currency, from the browser's region */
export const localCurrency = (locale = navigator.language): string => {
  const region = locale.split('-')[1]?.toLowerCase() ?? '';
  return region === 'gb'
    ? 'gbp'
    : region === 'ca'
      ? 'cad'
      : EURO.has(region)
        ? 'eur'
        : region === 'in'
          ? 'inr'
          : region === 'br'
            ? 'brl'
            : region === 'ar'
              ? 'ars'
              : 'usd';
};

/** the app to preselect: the last one used if it takes the currency, else the first that does */
export const defaultApp = (currency: string, last?: string): PayApp | undefined => {
  const prev = payApp(last);
  return prev && appTakes(prev, currency) ? prev : PAY_APPS.find(a => appTakes(a, currency));
};
