/**
 * The buy page's one store. The open buy (machine.ts) is the source of truth
 * for where a buy stands; this adds only what the page is doing right now:
 * the form, the live quote, and the wait in progress with its real steps.
 * Every network call here follows a tap or the page being visible.
 */

import { createStore } from 'zustand/vanilla';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { useStore } from '../../state';
import { activeAccountIndex } from '../../state/pockets';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import { deriveAddressInWorker, spawnNetworkWorker } from '../../state/keyring/network-worker';
import { refreshEgress } from '../../net/egress';
import { setDestinationOptIn } from '../../net/ledger';
import { readEgressView } from '../../net/egress-opt-in';
import {
  appTakes,
  defaultApp,
  localCurrency,
  payApp,
  PAY_APPS,
  type TemplateKey,
} from '../../buy/apps';
import { baseAddressOf, withBaseAccount } from '../../buy/base-key';
import {
  baseReader,
  enoughGas,
  gasState,
  sendUsdc,
  TransferReverted,
  usdcOf,
} from '../../buy/base-chain';
import { fiatUnits, type Offer } from '../../buy/fees';
import {
  advance,
  isTerminal,
  loadOffer,
  resume,
  startBuy,
  type Facts,
  type OpenBuy,
} from '../../buy/machine';
import {
  cancel,
  fetchQuotes,
  heldIntent,
  intentFulfilled,
  intentHeld,
  preloadPeerSdk,
  release,
  reserve,
  sealForVerifier,
  type Quotes,
} from '../../buy/peer';
import {
  announceDeposit,
  estimateSwap,
  quoteSwap,
  swapFacts,
  type SwapEstimate,
} from '../../buy/near-leg';
import { askForGas } from '../../buy/sponsor';
import { readBuyPrefs, readOpenBuy, writeBuyPrefs, writeOpenBuy } from '../../buy/store';
import templates from '../../buy/capture/templates.json';
import { pinTemplate, wantsIndex, type Row, type Template } from '../../buy/capture/template';
import { dropCaptureAccess, keepCaptureAccess, keptCaptureAccess } from '../../buy/capture/kept';
import {
  capturePayment,
  releaseCaptureAccess,
  requestCaptureAccess,
  sessionMaterial,
} from '../../buy/capture/run';
import { PEER_API } from '../../config/ramps';

/** the four services a buy talks to, asked once together */
export const BUY_EGRESS = ['peer', 'base', 'near-swap', 'sponsor'] as const;

export type Overlay =
  | 'gas' // needs a little eth, no sponsor
  | 'reserve' // holding the seller
  | 'ask' // may zafu look at the app once
  | 'reading' // reading the app
  | 'choose' // several payments match
  | 'verify' // peer's verifier, then the release
  | 'failed'; // the payment was not found yet

export type Sheet = 'app' | 'seller' | 'cur' | 'gone';

/** one line of a wait: what happened, when, and whether it is the one running */
export interface Step {
  t: string;
  d?: string;
  at?: number;
  state: 'done' | 'now' | 'later';
}

export interface BuyState {
  phase: 'loading' | 'locked' | 'cannot' | 'ready';
  egress: 'unknown' | 'ask' | 'ok';
  base?: `0x${string}`;
  zcash?: string;
  walletLabel?: string;
  firstTime: boolean;
  currency: string;
  app: string;
  amount: string;
  offerIdx: number;
  quotes?: Quotes;
  /** the form (amount, currency, app) `quotes` answered: continue waits until it is the current one */
  quotedFor?: string;
  quoting: boolean;
  estimate?: SwapEstimate;
  /** the offer `estimate` was made for: an estimate for another one never shows or sticks */
  estimateFor?: string;
  gas: 'unknown' | 'sponsored' | 'needs-eth' | 'ok';
  buy: OpenBuy | null;
  overlay: Overlay | null;
  sheet: Sheet | null;
  steps: Step[];
  /** when the current wait began */
  since?: number;
  /** a row choice when several payments match */
  rows: Row[];
  bank?: TemplateKey;
  keep: boolean;
  resumed: boolean;
  error?: string;
}

const initial: BuyState = {
  phase: 'loading',
  egress: 'unknown',
  firstTime: true,
  currency: 'usd',
  app: 'revolut',
  amount: '100',
  offerIdx: 0,
  quoting: false,
  gas: 'unknown',
  buy: null,
  overlay: null,
  sheet: null,
  steps: [],
  rows: [],
  keep: false,
  resumed: false,
};

export const buyStore = createStore<BuyState>()(() => initial);
const set = (p: Partial<BuyState>) => buyStore.setState(p);
const get = () => buyStore.getState();

/** the form a quote answers */
export const formKey = (s: Pick<BuyState, 'amount' | 'currency' | 'app'>): string =>
  `${fiatUnits(s.amount) ?? ''}|${s.currency}|${s.app}`;

/** one offer, as its estimate is keyed */
export const offerKey = (o: Offer): string => `${o.depositId}|${o.net}`;

/** the quotes on screen answer the form as it is now */
export const quoteIsCurrent = (s: BuyState): boolean =>
  !s.quoting && !!s.quotes && s.quotedFor === formKey(s);

/** the estimate on screen belongs to `o` */
export const estimateOf = (s: BuyState, o?: Offer): SwapEstimate | undefined =>
  o && s.estimate && s.estimateFor === offerKey(o) ? s.estimate : undefined;

/** the offer the page would reserve right now */
export const chosenOffer = (s: BuyState): Offer | undefined =>
  s.buy
    ? loadOffer(s.buy.offer)
    : s.quotes?.kind === 'offers'
      ? s.quotes.offers[s.offerIdx]
      : undefined;

const hotKey = () => {
  const k = useStore.getState().keyRing.selectedKeyInfo;
  return k?.type === 'mnemonic' ? k : undefined;
};

const mnemonic = async (): Promise<string> => {
  const k = hotKey();
  if (!k) {
    throw new Error(
      'this wallet signs elsewhere · please choose one whose phrase is on this computer',
    );
  }
  return useStore.getState().keyRing.getMnemonic(k.id);
};

/** a fresh shielded address of the active pocket, never the one on the receive screen */
const freshShielded = async (): Promise<string> => {
  const k = hotKey();
  if (!k) {
    throw new Error(
      'this wallet signs elsewhere · please choose one whose phrase is on this computer',
    );
  }
  const vault = await useStore.getState().keyRing.getVaultUnlock(k.id);
  const d = Array.from(crypto.getRandomValues(new Uint8Array(11)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  await spawnNetworkWorker('zcash');
  const raw = await deriveAddressInWorker(
    'zcash',
    vault,
    0,
    d,
    activeAccountIndex(useStore.getState()),
  );
  return fixOrchardAddress(raw, true);
};

const save = async (b: OpenBuy | null) => {
  set({ buy: b });
  await writeOpenBuy(b);
};

/** steps for a wait; `now` marks which one is running */
const stepsOf = (lines: [string, string?][], now: number, at: number[] = []): Step[] =>
  lines.map(([t, d], i) => ({
    t,
    d,
    at: at[i],
    state: i < now ? 'done' : i === now ? 'now' : 'later',
  }));

/** advance the running step to `i`, stamping when the finished ones landed */
const stepTo = (i: number, patch?: (s: Step[]) => Step[]) => {
  const now = Date.now();
  const steps = get().steps.map((s, j) => ({
    ...s,
    state: j < i ? 'done' : j === i ? 'now' : 'later',
    at: j < i ? (s.at ?? now) : s.at,
  })) as Step[];
  set({ steps: patch ? patch(steps) : steps });
};

/** the keyring has read the vaults from storage (persist.ts runs its init on load) */
const keyringLoaded = () =>
  new Promise<void>(resolve => {
    const loaded = () => useStore.getState().keyRing.status !== 'not-loaded';
    if (loaded()) {
      resolve();
      return;
    }
    const stop = useStore.subscribe(() => {
      if (loaded()) {
        stop();
        resolve();
      }
    });
  });

/** the password, from the page's own unlock (keyring unlock re-hydrates sealed state) */
export const unlock = (password: string): Promise<boolean> =>
  useStore.getState().keyRing.unlock(password);

export const init = async () => {
  await keyringLoaded();
  if (!(await sessionExtStorage.get('passwordKey'))) {
    set({ phase: 'locked' });
    return;
  }
  const key = hotKey();
  if (!key) {
    set({ phase: 'cannot' });
    return;
  }
  const [prefs, buy, view, keep] = await Promise.all([
    readBuyPrefs(),
    readOpenBuy(),
    readEgressView(),
    // the box shows what is really kept (and an expired keep is given back here)
    keptCaptureAccess(),
  ]);
  const currency = prefs.currency ?? localCurrency();
  const app = defaultApp(currency, prefs.app)?.id ?? 'revolut';
  const egress = BUY_EGRESS.every(id => view.find(d => d.id === id)?.on) ? 'ok' : 'ask';
  set({
    phase: 'ready',
    egress,
    currency,
    app,
    firstTime: !prefs.app,
    keep,
    buy,
    resumed: !!buy && !isTerminal(buy.stage),
    walletLabel: key.name,
    base: await baseAddressOf(await mnemonic()),
  });
  if (egress === 'ok') {
    void afterAllowed();
  }
};

/** the ask-once sheet's "allow and continue" */
export const allowEgress = async () => {
  for (const id of BUY_EGRESS) {
    await setDestinationOptIn(id, 'allowed');
  }
  await refreshEgress();
  set({ egress: 'ok' });
  void afterAllowed();
};

const afterAllowed = async () => {
  preloadPeerSdk();
  if (get().buy) {
    await check();
  } else {
    requote();
  }
  // the zec address is derived locally, off the screen's way
  if (!get().zcash) {
    set({ zcash: get().buy?.zcash ?? (await freshShielded()) });
  }
  // a buy that is waiting on the person keeps its estimate current
  const b = get().buy;
  if (b && !b.near && (b.stage === 'pay' || b.stage === 'confirming')) {
    const o = loadOffer(b.offer);
    const estimate = await estimateSwap(o.net, b.base, b.zcash).catch(() => undefined);
    if (estimate) {
      set({ estimate, estimateFor: offerKey(o) });
    }
  }
};

let quoteCtl: AbortController | undefined;
let quoteTimer: ReturnType<typeof setTimeout> | undefined;

/** ask peer again (debounced as the person types); the last answer stays on screen meanwhile */
export const requote = (delay = 0): void => {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => void runQuote(), delay);
};

const runQuote = async () => {
  const s = get();
  const fiat = fiatUnits(s.amount);
  const app = payApp(s.app);
  if (s.egress !== 'ok' || !s.base || !fiat || !app || !appTakes(app, s.currency)) {
    return;
  }
  quoteCtl?.abort();
  const ctl = (quoteCtl = new AbortController());
  // what this answer is for: the form may move on while it is out
  const asked = formKey(s);
  set({ quoting: true });
  try {
    const quotes = await fetchQuotes({
      platform: app.id,
      currency: s.currency,
      fiat,
      address: s.base,
      signal: ctl.signal,
    });
    if (ctl.signal.aborted) {
      return;
    }
    set({ quotes, quotedFor: asked, offerIdx: 0, quoting: false, error: undefined });
    const best = quotes.kind === 'offers' ? quotes.offers[0] : undefined;
    const zcash = get().zcash;
    if (best && zcash) {
      const estimate = await estimateSwap(best.net, s.base, zcash).catch(() => undefined);
      // a newer quote went out meanwhile: this estimate is for an offer no longer shown
      if (estimate && !ctl.signal.aborted) {
        set({ estimate, estimateFor: offerKey(best) });
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) {
      set({ quoting: false, error: (e as Error).message });
    }
  }
};

/** the offers on screen stay, dimmed, until the new amount's answer is in; continue waits for it */
export const setAmount = (amount: string) => {
  set({ amount });
  requote(400);
};
export const setCurrency = (currency: string) => {
  const app = defaultApp(currency, get().app)?.id ?? get().app;
  set({
    currency,
    app,
    sheet: null,
    quotes: undefined,
    estimate: undefined,
    estimateFor: undefined,
  });
  void writeBuyPrefs({ currency });
  requote();
};
export const setApp = (app: string) => {
  set({ app, quotes: undefined, estimate: undefined, estimateFor: undefined });
  void writeBuyPrefs({ app });
  requote();
};
export const setOffer = (offerIdx: number) => set({ offerIdx });
export const openSheet = (sheet: Sheet | null) => set({ sheet });

/** continue: gas, then hold the seller's usdc for the person */
export const reserveNow = async () => {
  const s = get();
  const o = chosenOffer(s);
  // never an offer made for another amount than the one on screen
  if (!o || !s.base || !s.zcash || !quoteIsCurrent(s)) {
    return;
  }
  const estimate = estimateOf(s, o);
  const lines: [string, string?][] = [
    ['base gas', 'a few cents of eth for the network fee'],
    ['signed with your zafu base key', `asking for ${(Number(o.gross) / 1e6).toFixed(2)} usdc`],
    [`holding ${o.handle}'s usdc`, 'waiting for a base block'],
    [`pay ${o.handle}`, 'then you have 6 hours'],
  ];
  set({ overlay: 'reserve', steps: stepsOf(lines, 0), since: Date.now(), error: undefined });
  try {
    if (!(await ensureGas(o, 3, reserveNow))) {
      return;
    }
    stepTo(1);
    const draft: OpenBuy = {
      ...startBuy({
        app: s.app,
        currency: s.currency,
        base: s.base,
        zcash: s.zcash,
        walletLabel: s.walletLabel,
        offer: o,
      }),
      ...(estimate && {
        estimate: { amountOut: estimate.amountOut.toString(), cost: estimate.cost.toString() },
      }),
    };
    await save(draft);
    let sent: `0x${string}` | undefined;
    try {
      const held = await withBaseAccount(await mnemonic(), account =>
        reserve(account, o, tx => {
          sent = tx;
          stepTo(2);
        }),
      );
      stepTo(3);
      await save(
        advance(draft, 'pay', {
          reserveTx: held.tx,
          intentHash: held.intentHash,
          expiresAt: held.expiresAt,
        }),
      );
    } catch (e) {
      if (!sent) {
        throw e;
      }
      // the reserve went out: keep it, and let the visible check find the intent
      await save({ ...draft, reserveTx: sent });
      set({ overlay: null, error: undefined });
      return;
    }
    void writeBuyPrefs({ app: s.app, currency: s.currency });
    set({ overlay: null, resumed: false });
  } catch (e) {
    await save(null);
    const msg = (e as Error).message;
    // a guess from the sdk's words: the seller filled up between the quote and the reserve
    const gone = /liquidity|insufficient|deposit/i.test(msg);
    set({ overlay: null, sheet: gone ? 'gone' : null, error: gone ? undefined : msg });
    requote();
  }
};

/** what "check again" on the gas screen resumes: the step that found too little eth */
let afterGas: (() => Promise<void>) | undefined;

/**
 * Enough eth on the base address for the `txs` transactions still to send,
 * from zafu's sponsor or the person. Checked before each step that sends, not
 * only at the reserve: the price of gas moves over the hours a buy can take.
 * When there is too little, the gas screen shows and "check again" runs `then`.
 */
const ensureGas = async (o: Offer, txs: number, then: () => Promise<void>): Promise<boolean> => {
  const s = get();
  const base = s.base!;
  if (enoughGas(await gasState(base, txs))) {
    set({ gas: get().gas === 'sponsored' ? 'sponsored' : 'ok' });
    return true;
  }
  const drip = await askForGas(base, o, get().buy?.currency ?? s.currency);
  if (drip.ok) {
    set({ gas: 'sponsored' });
    for (let i = 0; i < 30; i++) {
      if (enoughGas(await gasState(base, txs))) {
        return true;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  afterGas = then;
  set({ gas: 'needs-eth', overlay: 'gas' });
  return false;
};

/** the gas screen's "check again": the step that stopped for eth, else the reserve */
export const gasAgain = async () => {
  const then = afterGas ?? reserveNow;
  afterGas = undefined;
  set({ overlay: null });
  await then();
};

/**
 * "i've paid" (or "i did pay" once the time ran out): the person says the
 * money went. From here the buy is never ended on time alone; ask to look once.
 */
export const paid = async () => {
  const b = get().buy;
  if (b && (b.stage === 'pay' || b.stage === 'expired')) {
    await save(advance(b, 'confirming'));
  }
  set({ overlay: 'ask', error: undefined });
};

export const setBank = (bank: TemplateKey) => set({ bank });
export const setKeep = (keep: boolean) => {
  set({ keep });
  // unticking a kept grant gives it back now, not at the next buy
  if (!keep) {
    void keptCaptureAccess().then(on => (on ? dropCaptureAccess() : undefined));
  }
};

const liveTemplate = async (key: TemplateKey, hosts: readonly string[]): Promise<Template> => {
  const bundled = templates[key] as Template;
  const platform = key.startsWith('zelle') ? 'zelle' : key;
  const live = await fetch(`${PEER_API}/providers/${platform}/${bundled.actionType}.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  return pinTemplate(live, bundled, hosts);
};

/** "allow for this buy": Chrome's grant inside the tap, then read the app once */
export const allowRead = async () => {
  const s = get();
  const app = payApp(s.buy?.app);
  const key = app && (s.bank && app.templates.includes(s.bank) ? s.bank : app.templates[0]);
  if (!app || !key || !s.buy) {
    return;
  }
  // the first call after the tap: Chrome grants only inside a user gesture
  // (already granted resolves true with no prompt)
  const granted = await requestCaptureAccess();
  if (!granted) {
    return;
  }
  await setDestinationOptIn(`pay-${app.id}`, 'allowed');
  await refreshEgress();
  if (s.keep) {
    await keepCaptureAccess(app.id);
  }
  await readPayment(app.id, key);
};

const readPayment = async (appId: string, key: TemplateKey) => {
  const app = payApp(appId)!;
  const b = get().buy!;
  const o = loadOffer(b.offer);
  const lines: [string, string?][] = [
    [`opened ${app.site} in a new tab`, 'signed in as you'],
    [
      `found ${(Number(o.fiat) / 1e6).toFixed(2)} ${b.currency} to ${o.handle}`,
      'the payment you made',
    ],
    ["sealing it for peer's verifier", 'encrypted here, kept in memory only'],
    ["peer's verifier checks it", ''],
  ];
  set({ overlay: 'reading', steps: stepsOf(lines, 0), since: Date.now(), bank: key, rows: [] });
  try {
    const template = await liveTemplate(key, app.hosts);
    const got = await capturePayment({
      app,
      template,
      expect: { fiat: Number(o.fiat) / 1e6, currency: b.currency, handle: o.handle },
      onStep: st => stepTo(st === 'found' ? 2 : st === 'seen' ? 1 : 0),
    });
    if (got.kind !== 'found') {
      set({ overlay: got.kind === 'closed' ? 'ask' : 'failed' });
      return;
    }
    const row = got.rows.length === 1 ? got.rows[0]! : undefined;
    const sealed = await sealForVerifier({
      platform: template.metadata.platform,
      actionType: template.actionType,
      sessionMaterial: sessionMaterial(got.seen),
    });
    if (!row) {
      pending = { sealed, template, key };
      set({ overlay: 'choose', rows: got.rows });
      return;
    }
    await verify(row, sealed, template, key);
  } catch (e) {
    set({ overlay: 'failed', error: (e as Error).message });
  } finally {
    if (!get().keep) {
      void releaseCaptureAccess();
    }
  }
};

let pending: { sealed: string; template: Template; key: TemplateKey } | undefined;

/** several payments matched; the person points at theirs */
export const chooseRow = async (row: Row) => {
  const p = pending;
  pending = undefined;
  if (p) {
    await verify(row, p.sealed, p.template, p.key);
  }
};

const VERIFY_LINES: [string, string?][] = [
  ['payment sealed and sent', "to peer's verifier"],
  ["peer's verifier is checking", 'it confirms the record with the app'],
  ['usdc to your zafu base account', 'one base transaction'],
  ['swap to shielded zec', 'a fresh near quote'],
];

const verify = async (row: Row, sealed: string, template: Template, key: TemplateKey) => {
  const b = get().buy!;
  // the release and the send to the swap still need eth: checked now, at today's price
  if (!(await ensureGas(loadOffer(b.offer), 2, () => verify(row, sealed, template, key)))) {
    return;
  }
  set({ overlay: 'verify', steps: stepsOf(VERIFY_LINES, 1, [Date.now()]), since: Date.now() });
  try {
    const params = { ...row.params, ...(wantsIndex(key) ? { index: row.originalIndex } : {}) };
    const tx = await withBaseAccount(await mnemonic(), account =>
      release(
        account,
        {
          intentHash: b.intentHash!,
          encryptedSessionMaterial: sealed,
          params,
          platform: template.metadata.platform,
          actionType: template.actionType,
        },
        st => stepTo(st === 'checking' ? 1 : 2),
      ),
    );
    stepTo(3);
    await save(advance(get().buy!, 'released', { fulfillTx: tx }));
    set({ overlay: null });
    await swapNow();
  } catch (e) {
    set({ overlay: 'failed', error: (e as Error).message });
  }
};

/** one swap leg at a time: the 15 s check and the release can both reach swapNow */
let swapping: Promise<void> | undefined;

/**
 * Usdc is on the base address: a fresh near quote, then send it. The leg
 * (deposit address, quote) is saved before the usdc moves and the transfer's
 * hash the moment it is out, so a closed tab can always find where it went.
 */
export const swapNow = (): Promise<void> =>
  (swapping ??= swapOnce().finally(() => (swapping = undefined)));

const swapOnce = async () => {
  const b = get().buy;
  if (!b || (b.stage !== 'released' && b.stage !== 'refunded')) {
    return;
  }
  let sent = false;
  try {
    const usdc = await usdcOf(b.base);
    const amount = usdc < BigInt(b.offer.net) ? usdc : BigInt(b.offer.net);
    if (amount === 0n) {
      set({ error: 'the usdc has not reached your zafu base account yet' });
      return;
    }
    if (!(await ensureGas(loadOffer(b.offer), 1, swapNow))) {
      return;
    }
    const near = await quoteSwap(amount, b.base, b.zcash);
    // a retry after a refund starts its own clock
    const leg = advance({ ...b, at: { ...b.at, swapping: undefined } }, 'swapping', {
      near,
      depositTx: undefined,
    });
    await save(leg);
    const tx = await withBaseAccount(await mnemonic(), account =>
      sendUsdc(account, near.depositAddress as `0x${string}`, BigInt(near.amountIn), hash => {
        sent = true;
        return save({ ...leg, depositTx: hash });
      }),
    );
    await announceDeposit(tx, near.depositAddress);
    set({ error: undefined });
  } catch (e) {
    // nothing left the base account (refused, or reverted): the usdc waits for a fresh try
    const cur = get().buy;
    if ((!sent || e instanceof TransferReverted) && cur?.stage === 'swapping') {
      await save({ ...cur, stage: b.stage, near: undefined, depositTx: undefined });
    }
    set({ error: (e as Error).message });
  }
};

/** read where the open buy stands; only ever while the page is visible */
export const check = async () => {
  const b = get().buy;
  if (!b || isTerminal(b.stage) || get().overlay) {
    return;
  }
  try {
    if (b.stage === 'reserving') {
      // a reserve that went out while the page was busy or closed: wait for
      // its block, then pick up the intent; one never sent is forgotten
      if (!b.reserveTx) {
        if (Date.now() - (b.at.reserving ?? 0) > 120_000) {
          await save(null);
        }
        return;
      }
      const receipt = await baseReader()
        .getTransactionReceipt({ hash: b.reserveTx })
        .catch(() => undefined);
      if (!receipt) {
        return;
      }
      const held =
        receipt.status === 'success' ? await heldIntent(b.base, b.offer.depositId) : undefined;
      await save(held ? advance(b, 'pay', held) : null);
      return;
    }
    const now = Date.now();
    const facts: Facts =
      b.stage === 'pay' || b.stage === 'confirming' || b.stage === 'lapsed'
        ? { now, intent: await intentNow(b) }
        : b.stage === 'swapping' && b.near
          ? { now, ...(await swapFacts(b.near.depositAddress)) }
          : { now };
    // a sent transfer that reverted moved nothing: the usdc waits for a fresh quote
    if (b.stage === 'swapping' && b.depositTx && facts.swap === 'pending') {
      const r = await baseReader()
        .getTransactionReceipt({ hash: b.depositTx })
        .catch(() => undefined);
      if (r && r.status !== 'success') {
        await save({ ...b, stage: 'released', near: undefined, depositTx: undefined });
        await swapNow();
        return;
      }
    }
    const next = resume(b, facts);
    if (next !== b) {
      await save(next);
    }
    if (next.stage === 'released') {
      await swapNow();
    }
  } catch {
    // a read that failed is retried on the next visible tick
  }
};

/** where the intent stands on chain: held, released to this buy, gone, or not known yet */
const intentNow = async (b: OpenBuy): Promise<'held' | 'fulfilled' | 'gone' | undefined> => {
  if (!b.intentHash) {
    return undefined;
  }
  if (await intentHeld(b.base, b.intentHash)) {
    return 'held';
  }
  const released = await intentFulfilled({
    intentHash: b.intentHash,
    to: b.base,
    fulfillTx: b.fulfillTx,
    reserveTx: b.reserveTx,
  });
  return released === undefined ? undefined : released ? 'fulfilled' : 'gone';
};

/** cancel before paying: the seller's usdc goes back at once, nothing was taken */
export const cancelBuy = async () => {
  const b = get().buy;
  try {
    if (b?.intentHash) {
      await withBaseAccount(await mnemonic(), account => cancel(account, b.intentHash!));
    }
    await save(null);
    set({ overlay: null, resumed: false, error: undefined });
    requote();
  } catch (e) {
    set({ error: (e as Error).message });
  }
};

/** leave a finished buy behind */
export const finish = async () => {
  await save(null);
  set({ overlay: null, resumed: false, steps: [] });
  requote();
};

export const closeOverlay = () => set({ overlay: null, error: undefined });
export const lookAgain = () => set({ overlay: 'ask' });

export { PAY_APPS };
