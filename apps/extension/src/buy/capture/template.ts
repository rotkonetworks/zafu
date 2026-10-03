/**
 * Peer provider templates, read the way Peer's branded extension reads them
 * (docs.peer.xyz/developer/build-your-own-extension): which request to watch,
 * how to pull payment rows out of its response, and which public params the
 * verifier wants. Pure: no chrome, no network.
 */

import type { TemplateKey } from '../apps';

export interface Template {
  actionType: string;
  authLink: string;
  url: string;
  method: string;
  body?: string;
  metadata: {
    platform: string;
    method: string;
    urlRegex: string;
    bodyRegex?: string;
    fallbackMethod?: string;
    fallbackUrlRegex?: string;
    fallbackBodyRegex?: string;
    metadataUrl?: string;
    metadataUrlMethod?: string;
    metadataUrlBody?: string;
    preprocessRegex?: string;
    shouldReplayRequestInPage?: boolean;
    transactionsExtraction: {
      transactionJsonPathListSelector?: string;
      transactionJsonPathSelectors?: Record<string, string>;
    };
  };
  paramNames: string[];
  paramSelectors: { type: string; value: string; source?: string }[];
}

/** a request seen in the app's tab */
export interface Seen {
  url: string;
  method: string;
  headers: { name: string; value?: string }[];
  body?: string;
  /** filled by the replay */
  responseBody?: string;
}

/** one payment the app listed */
export interface Row {
  paymentId?: unknown;
  amount?: unknown;
  currency?: unknown;
  recipient?: unknown;
  recipientName?: unknown;
  date?: unknown;
  originalIndex: number;
  hidden: boolean;
  params: Record<string, string>;
}

/** templates whose verifier wants the row's index (Peer onramp guide, "Metadata Index Params") */
const INDEXED = new Set<TemplateKey>(['revolut', 'zelle_chase', 'zelle_bofa', 'zelle_citi']);
export const wantsIndex = (key: TemplateKey): boolean => INDEXED.has(key);

const hostIn = (s: string | undefined): string | undefined =>
  s ? /^https:\/\/([a-z0-9.-]+)/i.exec(s.replace(/\\/g, ''))?.[1]?.toLowerCase() : undefined;

/** every host a template can make zafu read or open */
export const templateHosts = (t: Pick<Template, 'authLink' | 'url' | 'metadata'>): string[] => [
  ...new Set(
    [t.authLink, t.url, t.metadata.urlRegex, t.metadata.fallbackUrlRegex, t.metadata.metadataUrl]
      .map(hostIn)
      .filter((h): h is string => !!h),
  ),
];

/**
 * A live template from api.zkp2p.xyz is remote config deciding what zafu
 * reads. Take it only when it is the same action and stays on the app's
 * pinned hosts; otherwise keep the bundled copy.
 */
export const pinTemplate = (
  live: unknown,
  bundled: Template,
  hosts: readonly string[],
): Template => {
  const t = live as Partial<Template> | null;
  const ok =
    !!t &&
    t.actionType === bundled.actionType &&
    typeof t.authLink === 'string' &&
    typeof t.metadata?.urlRegex === 'string' &&
    Array.isArray(t.paramNames) &&
    Array.isArray(t.paramSelectors) &&
    templateHosts(t as Template).every(h => hosts.includes(h));
  return ok ? (t as Template) : bundled;
};

const matches = (s: Seen, method?: string, urlRegex?: string, bodyRegex?: string): boolean =>
  !!method &&
  !!urlRegex &&
  s.method === method &&
  new RegExp(urlRegex).test(s.url) &&
  (!bodyRegex || new RegExp(bodyRegex).test(s.body ?? ''));

/** is this the request the template captures? */
export const isPaymentRequest = (s: Seen, t: Template): boolean => {
  const m = t.metadata;
  return (
    matches(s, m.method, m.urlRegex, m.bodyRegex) ||
    matches(s, m.fallbackMethod, m.fallbackUrlRegex, m.fallbackBodyRegex)
  );
};

/** the url patterns to watch: the request, its fallback, the replay url */
export const watchPatterns = (t: Template): RegExp[] =>
  [
    t.metadata.urlRegex,
    t.metadata.fallbackUrlRegex,
    t.metadata.metadataUrl?.replace(/\{\{[^}]+\}\}/g, '\\S+'),
  ]
    .filter((p): p is string => !!p)
    .map(p => new RegExp(p));

/** what to replay to read the rows: the metadata url when the template has one, else the request itself */
export const replayOf = (s: Seen, t: Template): Seen =>
  t.metadata.metadataUrl
    ? {
        ...s,
        url: t.metadata.metadataUrl,
        method: t.metadata.metadataUrlMethod || 'GET',
        body: t.metadata.metadataUrlBody || undefined,
      }
    : s;

/**
 * The JSONPath subset Peer's templates use: `$`, `.key`, `[n]` and `.[n]`.
 * Anything else answers undefined, never a guess.
 */
export const jsonPath = (path: string, json: unknown): unknown => {
  if (!path.startsWith('$')) {
    return undefined;
  }
  const steps = path.slice(1).match(/\.?\[\d+\]|\.[^.[\]]+/g) ?? [];
  if (steps.join('') !== path.slice(1)) {
    return undefined;
  }
  let at: unknown = json;
  for (const step of steps) {
    if (at === null || typeof at !== 'object') {
      return undefined;
    }
    const idx = /\[(\d+)\]/.exec(step)?.[1];
    at =
      idx !== undefined
        ? (at as unknown[])[Number(idx)]
        : (at as Record<string, unknown>)[step.slice(1)];
  }
  return at;
};

const parseJson = (s: string): unknown => {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return undefined;
  }
};

const responseJson = (body: string, t: Template): unknown => {
  const pre = t.metadata.preprocessRegex;
  return parseJson(pre ? (new RegExp(pre).exec(body)?.[1] ?? '') : body);
};

const at = (selector: string, i: number) => selector.replace(/\{\{INDEX\}\}/g, String(i));

/** the public params for row `i` (request-body selectors are private and never read here) */
const paramsFor = (t: Template, s: Seen, body: string, i: number): Record<string, string> => {
  const out: Record<string, string> = {};
  t.paramNames.forEach((name, n) => {
    const sel = t.paramSelectors[n];
    if (!sel || sel.source === 'requestBody') {
      return;
    }
    const src = sel.source === 'url' ? s.url : body;
    const v =
      sel.type === 'jsonPath'
        ? jsonPath(at(sel.value, i), sel.source === 'url' ? { url: src } : parseJson(src))
        : sel.type === 'regex'
          ? (() => {
              const all = [...src.matchAll(new RegExp(at(sel.value, i), 'g'))];
              const m = all[Math.min(i, all.length - 1)];
              return m?.[1] ?? m?.[0];
            })()
          : undefined;
    if (v !== undefined && v !== null && String(v).trim()) {
      out[name.trim()] = String(v).trim();
    }
  });
  return out;
};

/** every payment row in a replayed response */
export const extractRows = (t: Template, s: Seen, body: string): Row[] => {
  const ex = t.metadata.transactionsExtraction;
  const json = responseJson(body, t);
  const list = ex.transactionJsonPathListSelector
    ? jsonPath(ex.transactionJsonPathListSelector, json)
    : [json];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item: unknown, i) => {
    const fields = Object.fromEntries(
      Object.entries(ex.transactionJsonPathSelectors ?? {}).map(([k, p]) => [
        k,
        jsonPath(at(p, i), item),
      ]),
    );
    return {
      ...fields,
      originalIndex: i,
      hidden: Object.values(fields).some(v => v === undefined || v === null),
      params: paramsFor(t, s, body, i),
    };
  });
};

const amountOf = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : undefined;
};

const sameMoney = (v: unknown, fiat: number): boolean => {
  const n = amountOf(v);
  // apps list major units (100.00) or minor units (10000)
  return n !== undefined && (Math.abs(n - fiat) < 0.005 || Math.abs(n - fiat * 100) < 0.5);
};

const clean = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/^[@$]/, '');

/**
 * The rows that look like this payment: the amount, and the seller's handle
 * where the app shows one. One match is picked for the person; several are
 * offered; none means the payment is not listed yet.
 */
export const matchingRows = (
  rows: Row[],
  expect: { fiat: number; currency: string; handle: string },
): Row[] =>
  rows.filter(
    r =>
      !r.hidden &&
      sameMoney(r.amount, expect.fiat) &&
      (r.currency === undefined || clean(r.currency) === expect.currency.toLowerCase()) &&
      (r.recipient === undefined ||
        clean(r.recipient).includes(clean(expect.handle)) ||
        clean(r.recipientName).includes(clean(expect.handle))),
  );

/** what the verifier gets as session material: every captured header, plus the body */
export const sessionMaterial = (s: Seen): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of s.headers) {
    if (h.name?.trim() && typeof h.value === 'string') {
      out[h.name.trim()] = h.value;
    }
  }
  if (s.body !== undefined) {
    out['body'] = s.body;
  }
  return out;
};
