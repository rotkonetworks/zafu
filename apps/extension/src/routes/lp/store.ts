/**
 * lp.html's one store. The flight (lp/flight.ts) is the source of truth for
 * an add or take-out on its way; this adds what the page is doing now: the
 * form, the last reads with their age, and which screen the person chose.
 * Reads run only while this tab is visible, and only to destinations the
 * person allowed on the first look.
 *
 * One lp.html tab writes (it holds the page lock); another open at the same
 * time only watches the stored flight, and takes over when the first closes.
 * Flight turns run one at a time under a lock, and every write is a
 * compare-and-set (lp/store.ts saveFlight), so a cancel always wins over a
 * turn that has not yet marked its send.
 */

import { createStore } from 'zustand/vanilla';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { useStore } from '../../state';
import { selectEffectiveKeyInfo } from '../../state/keyring';
import { activeAccountIndex, activePockets, activeZcashStoreId } from '../../state/pockets';
import {
  buildSendTxInWorker,
  getPoolBalancesInWorker,
  getTransparentUtxosInWorker,
  planTransparentDepositInWorker,
  sendTransparentDepositInWorker,
  shieldInWorker,
  signThorDepositInWorker,
  spawnNetworkWorker,
  thorAddressInWorker,
  type ThorKeyIn,
} from '../../state/keyring/network-worker';
import { refreshEgress } from '../../net/egress';
import { setDestinationOptIn } from '../../net/ledger';
import { readEgressView } from '../../net/egress-opt-in';
import { claimTAddress, tAddressAt } from '../../hooks/use-transparent-addresses';
import { depositFeeZat } from '../../workers/transparent-deposit';
import { drive, VAULT_MOVED_LINE, type DriveDeps } from '../../lp/drive';
import {
  cancelFlight,
  cancellable,
  isDone,
  isPaired,
  needs,
  recoverHalf,
  resumed,
  shieldRefund,
  StaleFlight,
  startFlight,
  type Flight,
} from '../../lp/flight';
import {
  ADD_MEMO,
  afterFee,
  askZat,
  DEFAULT_ADD,
  parseZec,
  pairedAddMemo,
  pairedWithdraw,
  pairedWithdrawMemo,
  parseZec as parseAmount,
  quoteAdd,
  RECOVER_MEMO,
  runeFor,
  withdrawMemo,
  withdrawZec,
  zecFor,
  type PayoutAs,
} from '../../lp/math';
import {
  beginFlight,
  changeFlight,
  changeLp,
  onLpChange,
  optInRune,
  optOutRune,
  patchLpPocket,
  readLpPocket,
  saveFlight,
  type LpCache,
  type LpRune,
  type RuneSource,
} from '../../lp/store';
import { randomThorKeyHex } from '@repo/wallet/networks/thorchain/derive';
import { selectActiveZcashWallet } from '../../state/wallets';
import {
  NO_ACCOUNT_LINE,
  pairedLive,
  quoteRune,
  readRune,
  readRuneTx,
  readSwapped,
  reserveOf,
  RUNE_FEE,
  sendRuneTx,
  type RuneQuote,
  type RuneRead,
} from '../../lp/rune';
import {
  lpEgress,
  MIDGARD_DEST,
  NotAllowed,
  PRICES_DEST,
  readMarketZec,
  readMidgard,
  readRefundReason,
  readThor,
  readTxSeen,
  readVault,
  THORNODE_DEST,
  type LpEgress,
  type MidgardRead,
  type ThorRead,
} from '../../lp/thor';

/** the three the page talks to, asked once together on the first look */
export const LP_EGRESS = [THORNODE_DEST, MIDGARD_DEST, PRICES_DEST] as const;

export type View = 'add' | 'position' | 'withdraw' | 'twoSided' | 'rune' | 'withdraw2';
export type Sheet = 'public' | 'history';

export interface LpState {
  phase: 'loading' | 'locked' | 'cannot' | 'ready';
  /** the first look, then the ask; null once thornode may be read */
  intro: 'first' | 'egress' | null;
  egress: LpEgress;
  /** the person blocked thornode in everything zafu talks to */
  blocked: boolean;
  view: View | null;
  sheet: Sheet | null;
  amt: string;
  part: 25 | 50 | 100;
  /** the pocket this page is bound to, from the load: it never follows a switch in the popup */
  storeId?: string;
  keyId?: string;
  account?: number;
  pocket: string;
  /** zafu now shows another wallet or pocket than this page's: nothing is sent */
  away?: boolean;
  /** another lp.html tab writes; this one only watches */
  follower?: boolean;
  /** the dust THORNode said at the page's first read: an ask past ten times it is refused */
  dustAtOpen?: bigint;
  lp?: { index: number; address: string };
  cache?: LpCache;
  thor?: ThorRead;
  mid?: MidgardRead;
  zecUsd?: number;
  pxAt?: number;
  /** why the last read failed, in one calm line */
  readErr?: string;
  flight?: Flight;
  /** the flight the person confirmed in this tab: only that one sends */
  confirmed?: string;
  /** a reopened add whose price moved since its confirm: shown, and continue asks again */
  moved?: { was?: number; now: number };
  shieldedZat?: bigint;
  error?: string;
  /** the pocket's rune opt-in, as stored; undefined until the person chose rune here */
  rune?: LpRune;
  /** a cold wallet's choice at the opt-in: a new key here (default) or the viewing key */
  runeChoice: 'random' | 'fvk';
  /** the bound wallet signs on a device: the opt-in offers the choice */
  cold?: boolean;
  /** the thor1's balance, account and paired position: read only while the opt-in is on */
  runeRead?: RuneRead;
  runeErr?: string;
  /** a two-sided take-out pays both sides, or all in one */
  payoutAs: PayoutAs;
  /** the zec to swap for rune, typed */
  swapAmt: string;
  swapQuote?: RuneQuote;
  swapErr?: string;
}

const initial: LpState = {
  phase: 'loading',
  intro: 'first',
  egress: { thornode: false, midgard: false, prices: false },
  blocked: false,
  view: null,
  sheet: null,
  amt: DEFAULT_ADD,
  part: 100,
  pocket: 'main pocket',
  payoutAs: 'both',
  swapAmt: '',
  runeChoice: 'random',
};

/** the zcash network fee of a shield-out to a t-address, about: two orchard actions and the t-output */
export const SHIELD_OUT_FEE = 15_000n;
/** one shielding input */
export const SHIELD_BACK_FEE = 10_000n;
/** what an add pays the networks on top of its amount */
export const ADD_FEES = SHIELD_OUT_FEE + depositFeeZat(ADD_MEMO.length);

export const ASK_CAP_LINE =
  "thorchain's least amount for a take-out is past what zafu pays for one · nothing was sent · please try again later";
export const CANCEL_LATE_LINE =
  'this step had already gone out, so it can no longer be cancelled · it is tracked here';
export const HALF_WAITING_LINE =
  'a half is still waiting in the pool · please take it back from your position first · nothing was sent';
export const BUSY_LINE = 'an add or take-out is already on its way · please finish it first';

export const lpStore = createStore<LpState>()(() => initial);
const set = (p: Partial<LpState>) => lpStore.setState(p);
const get = () => lpStore.getState();

const hotKey = () => {
  const k = selectEffectiveKeyInfo(useStore.getState());
  return k?.type === 'mnemonic' ? k : undefined;
};

const zidecar = () =>
  useStore.getState().networks.networks.zcash.endpoint || 'https://zcash.rotko.net';

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

export const unlock = (password: string): Promise<boolean> =>
  useStore.getState().keyRing.unlock(password);

/** the position the last read saw, if any */
export const positionOf = (s: Pick<LpState, 'thor'>) => {
  const p = s.thor?.position;
  return p && (p.units > 0n || p.pendingAsset > 0n) ? p : undefined;
};

/** worth now if all were taken out, after the pool's fee */
export const worthOf = (s: Pick<LpState, 'thor'>, bps = 10_000): bigint | undefined => {
  const t = s.thor;
  const p = positionOf(s);
  return t && p
    ? afterFee(withdrawZec(t.pool, p.units, bps, t.minSlipBps), t.inbound?.outboundFee ?? 0n)
    : undefined;
};

/** the page lock: held by the one tab that writes, until it closes */
const pageLock = () => `${chrome.runtime.id}.zec-lp-page`;
/** one flight turn at a time */
const turnLock = () => `${chrome.runtime.id}.zec-lp-turn`;
const forever = new Promise<never>(() => undefined);

/** true when this tab took the page lock; otherwise it watches and queues for it */
let leading: Promise<boolean> | undefined;
const lead = () =>
  (leading ??= new Promise<boolean>(resolve => {
    void navigator.locks.request(pageLock(), { ifAvailable: true }, async lock => {
      resolve(!!lock);
      if (lock) {
        await forever;
      }
    });
  }));

/** the other tab closed: this one writes now, and treats its record as reopened */
const takeOver = () =>
  void navigator.locks.request(pageLock(), async () => {
    set({ follower: false });
    const { storeId } = get();
    const rec = storeId ? await readLpPocket(storeId) : undefined;
    if (storeId && rec?.flight) {
      const f = resumed(rec.flight);
      set({ flight: f });
      if (f !== rec.flight) {
        await saveFlight(storeId, f).catch(() => undefined);
      }
    }
    if (get().egress.thornode && !get().intro) {
      await ensureLpAddress();
      void tick();
    }
    await forever;
  });

/** why this page may not send now: zafu shows another wallet or pocket than the one it was opened for */
const awayLine = (): string | undefined => {
  const { storeId, keyId, pocket } = get();
  const s = useStore.getState();
  return activeZcashStoreId(s) !== storeId || selectEffectiveKeyInfo(s)?.id !== keyId
    ? `this page is for ${pocket} · zafu now shows another wallet or pocket · please switch back to it to continue · nothing was sent`
    : undefined;
};

let reads = 0;
/** the stored record, read again: the newest read wins */
const reload = async () => {
  const { storeId } = get();
  if (!storeId) {
    return;
  }
  const n = ++reads;
  const rec = await readLpPocket(storeId);
  if (n === reads) {
    set({
      flight: rec?.flight,
      cache: rec?.cache,
      rune: rec?.rune,
      ...(rec?.rune?.on ? {} : { runeRead: undefined }),
      ...(rec?.address ? { lp: { index: rec.index, address: rec.address } } : {}),
    });
  }
};

let watching = false;
/** once per page: the stored record and the active pocket, followed */
const watch = () => {
  if (watching) {
    return;
  }
  watching = true;
  onLpChange(() => void reload());
  useStore.subscribe(() => {
    const away = !!awayLine();
    if (away !== !!get().away) {
      set({ away });
    }
  });
};

let booting: Promise<void> | undefined;
/** once at a time: a second call (the unlock column, a double mount) waits on the first */
export const init = (): Promise<void> =>
  (booting ??= boot().finally(() => {
    booting = undefined;
  }));

const boot = async () => {
  await keyringLoaded();
  if (!(await sessionExtStorage.get('passwordKey'))) {
    set({ phase: 'locked' });
    return;
  }
  const key = hotKey();
  const s = useStore.getState();
  const storeId = activeZcashStoreId(s);
  if (!key || !storeId) {
    set({ phase: 'cannot' });
    return;
  }
  const account = activeAccountIndex(s);
  const pocket = activePockets(s).find(p => p.account === account)?.name ?? 'main pocket';
  const [rec, egress, view, prefs, leader] = await Promise.all([
    readLpPocket(storeId),
    lpEgress(),
    readEgressView(),
    readLpPrefs(),
    lead(),
  ]);
  // only the writing tab treats a stored send as reopened; a watching tab shows what is stored
  const flight = rec?.flight && (leader ? resumed(rec.flight) : rec.flight);
  set({
    phase: 'ready',
    storeId,
    keyId: key.id,
    cold: isColdKey(key.type),
    account,
    pocket,
    away: false,
    follower: !leader,
    egress,
    blocked: view.find(d => d.id === THORNODE_DEST)?.why === 'you-blocked',
    intro: needsAsk(view) ? (prefs.seen ? 'egress' : 'first') : null,
    cache: rec?.cache,
    flight,
    rune: rec?.rune,
    lp: rec?.address ? { index: rec.index, address: rec.address } : undefined,
  });
  watch();
  if (!leader) {
    takeOver();
    if (egress.thornode && !get().intro) {
      void refresh();
    }
    return;
  }
  if (flight && rec?.flight && flight !== rec.flight) {
    await saveFlight(storeId, flight).catch(() => reload());
  }
  // an opted-in rune account restored without its address: derived again in the worker
  if (rec?.rune?.on && !rec.rune.address) {
    await deriveRune().catch(() => undefined);
  }
  // a restored index has no address yet: derived here, locally
  if (rec && !rec.address) {
    const address = await tAddressAt(useStore.getState(), rec.index, true);
    if (address) {
      await patchLpPocket(storeId, { address });
      set({ lp: { index: rec.index, address } });
    }
  }
  if (egress.thornode && !get().intro) {
    await ensureLpAddress();
    void tick();
  }
};

let claiming: Promise<void> | undefined;
/** the pocket's one lp address: claimed once, from the counter swaps use; one claim at a time */
const ensureLpAddress = (): Promise<void> =>
  (claiming ??= claim().finally(() => {
    claiming = undefined;
  }));

const claim = async () => {
  const { storeId, lp, follower } = get();
  if (lp || !storeId || follower) {
    return;
  }
  // stored by another realm since the load: no second index is claimed
  const had = await readLpPocket(storeId);
  if (had?.address) {
    set({ lp: { index: had.index, address: had.address } });
    return;
  }
  const t = await claimTAddress(useStore.getState(), true);
  await changeLp(book =>
    book[storeId] ? book : { ...book, [storeId]: { index: t.index, address: t.address } },
  );
  const rec = await readLpPocket(storeId);
  if (rec?.address) {
    set({ lp: { index: rec.index, address: rec.address } });
  }
};

/** a plain convenience, like the buy page's: the first look was seen, so the ask comes first */
const PREFS = 'lpPrefs';
const readLpPrefs = async (): Promise<{ seen?: boolean }> => {
  const v = (await chrome.storage.local.get(PREFS))[PREFS] as unknown;
  return v && typeof v === 'object' ? (v as { seen?: boolean }) : {};
};

/**
 * The first look and the ask show while any of the three is still off and not
 * blocked by the person: one already allowed for swaps doesn't skip the others.
 */
export const needsAsk = (view: { id: string; on: boolean; why: string }[]): boolean =>
  LP_EGRESS.some(id => {
    const d = view.find(v => v.id === id);
    return !!d && !d.on && d.why !== 'you-blocked';
  });

export const goEgress = () => {
  set({ intro: 'egress' });
  void chrome.storage.local.set({ [PREFS]: { seen: true } });
};
export const goFirst = () => set({ intro: 'first' });

/** the ask-once list's "allow and continue": thornode, midgard and the market price; one the person blocked stays blocked */
export const allowEgress = async () => {
  const view = await readEgressView();
  for (const id of LP_EGRESS) {
    if (view.find(d => d.id === id)?.why !== 'you-blocked') {
      await setDestinationOptIn(id, 'allowed');
    }
  }
  await refreshEgress();
  set({ egress: await lpEgress(), intro: null, blocked: false });
  await ensureLpAddress();
  void tick();
};

/** the blocked screen's "allow thornode": thornode only, as the person said */
export const allowThornode = async () => {
  await setDestinationOptIn(THORNODE_DEST, 'allowed');
  await refreshEgress();
  set({ egress: await lpEgress(), intro: null, blocked: false });
  await ensureLpAddress();
  void tick();
};

const lineOf = (e: unknown) =>
  e instanceof NotAllowed
    ? 'not allowed'
    : e instanceof Error && e.message
      ? e.message
      : 'the node did not answer';

/** read the pool, the position, activity and the market; keep the home card's copy */
let refreshes = 0;
/** reads that overlap (the tick, a tab shown, a continue): only the newest is applied */
export const refresh = async () => {
  const { egress, lp, storeId } = get();
  if (!egress.thornode) {
    return;
  }
  const n = ++refreshes;
  void refreshRune();
  const [thor, mid, zecUsd] = await Promise.all([
    readThor(lp?.address).catch((e: unknown) => {
      set({ readErr: lineOf(e) });
      return undefined;
    }),
    egress.midgard ? readMidgard(lp?.address).catch(() => undefined) : undefined,
    egress.prices ? readMarketZec().catch(() => undefined) : undefined,
  ]);
  if (n !== refreshes) {
    return;
  }
  if (thor) {
    set({ thor, readErr: undefined });
    if (get().dustAtOpen === undefined && thor.inbound && thor.inbound.dust > 0n) {
      set({ dustAtOpen: thor.inbound.dust });
    }
  }
  if (mid) {
    set({ mid });
  }
  if (zecUsd) {
    set({ zecUsd, pxAt: Date.now() });
  }
  if (thor && storeId) {
    const worth = worthOf({ thor });
    const p = thor.position;
    const cache: LpCache | undefined =
      worth !== undefined && p
        ? {
            zat: worth.toString(),
            sharePct: (Number(p.units) / Number(thor.pool.units)) * 100,
            readAt: thor.at,
          }
        : undefined;
    set({ cache });
    if (!get().follower) {
      await patchLpPocket(storeId, { cache });
    }
  }
  if (storeId) {
    void spawnNetworkWorker('zcash')
      .then(() => getPoolBalancesInWorker('zcash', storeId))
      .then(b => set({ shieldedZat: b.total }))
      .catch(() => undefined);
  }
};

/** the bound wallet's keys, and only while zafu still shows the pocket this page is for */
const vaultOf = async () => {
  const { keyId } = get();
  const away = awayLine();
  if (away) {
    throw new Error(away);
  }
  if (!keyId || hotKey()?.id !== keyId) {
    throw new Error(
      'this wallet signs elsewhere · please choose one whose phrase is on this computer',
    );
  }
  return useStore.getState().keyRing.getVaultUnlock(keyId);
};

/** the pocket this page is bound to signs, never the one the popup shows now */
const boundAccount = () => {
  const { account } = get();
  if (account === undefined) {
    throw new Error(
      'this wallet signs elsewhere · please choose one whose phrase is on this computer',
    );
  }
  return account;
};

const depsOf = (storeId: string, lp: { index: number; address: string }): DriveDeps => ({
  owner: storeId,
  address: lp.address,
  index: lp.index,
  away: awayLine,
  height: () => get().thor?.height,
  vault: readVault,
  plan: req => planTransparentDepositInWorker(zidecar(), req),
  shieldOut: async zat => {
    const r = await buildSendTxInWorker(
      'zcash',
      storeId,
      zidecar(),
      lp.address,
      zat.toString(),
      '',
      boundAccount(),
      true,
      await vaultOf(),
    );
    if (!('txid' in r)) {
      throw new Error(
        'this wallet signs elsewhere · please choose one whose phrase is on this computer',
      );
    }
    return r.txid;
  },
  deposit: async (req, fee) =>
    (
      await sendTransparentDepositInWorker(
        storeId,
        zidecar(),
        { ...req, reviewedFee: fee },
        await vaultOf(),
      )
    ).txid,
  shieldBack: async () => {
    // position in the list is the t-branch index that signs; only the lp address is read
    const list = Array.from({ length: lp.index + 1 }, (_, i) => (i === lp.index ? lp.address : ''));
    return (
      await shieldInWorker('zcash', storeId, await vaultOf(), zidecar(), list, true, undefined, [
        lp.address,
      ])
    ).txid;
  },
  seen: txid => readTxSeen(txid, lp.address),
  units: () => Promise.resolve(get().thor?.position?.units ?? 0n),
  utxoZat: async () =>
    (await getTransparentUtxosInWorker(zidecar(), [lp.address])).map(u => BigInt(u.valueZat)),
  refundReason: get().egress.midgard ? txid => readRefundReason(txid, lp.address) : undefined,
  // only with the opt-in on: a pocket that never chose rune has no rune side at all
  ...(runeOn()
    ? {
        runeSend: (memo: string, rune: bigint) => runeSend(memo, rune),
        paired: async () => (await readRune(runeOn()!.address!)).paired,
        swapped: (txid: string) => readSwapped(txid),
        runeTx: (hash: string) => readRuneTx(hash),
      }
    : {}),
  save: async (f, after) => {
    const w = await saveFlight(storeId, f, after);
    set({ flight: w });
    return w;
  },
});

/**
 * Turn the flight until it waits on the chain or the person. One turn at a
 * time (a lock); `wait` false skips when one is already running (the tick).
 * Each turn starts from the stored flight, so a cancel made meanwhile is
 * what it sees; a turn whose flight moved under it stops with nothing sent.
 */
const runFlight = async (wait = true): Promise<void> => {
  await navigator.locks.request(turnLock(), { ifAvailable: !wait }, async lock => {
    if (lock) {
      await turn();
    }
  });
};

const turn = async () => {
  const { storeId, lp, thor, follower } = get();
  if (follower || !storeId || !lp) {
    return;
  }
  let f = (await readLpPocket(storeId))?.flight;
  set({ flight: f });
  if (!f || isDone(f) || f.error) {
    return;
  }
  try {
    await spawnNetworkWorker('zcash');
    // a flight from before this tab watches, and waits for the person to say continue
    const mayAct = get().confirmed === f.id;
    for (let i = 0; i < (mayAct ? 4 : 1); i++) {
      const next = await drive(f, depsOf(storeId, lp), thor?.inbound?.address ?? '', mayAct);
      const moved = next.stage !== f.stage || !!next.error;
      f = next;
      if (!moved || !needs(f)) {
        break;
      }
    }
  } catch (e) {
    if (e instanceof StaleFlight) {
      await reload();
      return;
    }
    set({ error: lineOf(e) });
  }
};

/** what the page does each turn while visible: read, then move the flight on */
export const tick = async () => {
  await refresh();
  await runFlight(false);
};

export const setAmount = (amt: string) => set({ amt });
export const setPart = (part: LpState['part']) => set({ part });
export const openSheet = (sheet: Sheet | null) => set({ sheet });
export const show = (view: View | null) => set({ view, sheet: null, error: undefined });

/** a new flight, only when none is on its way in any tab */
const begin = async (storeId: string, f: Flight) => {
  const stored = await beginFlight(storeId, f);
  if (!stored) {
    await reload();
    set({ error: BUSY_LINE });
    return;
  }
  set({ flight: stored, view: null, confirmed: stored.id, moved: undefined, error: undefined });
  await runFlight();
};

/** add: the person confirmed; the flight starts and the tracker shows */
export const startAdd = async () => {
  const { storeId, lp, thor, amt, shieldedZat, follower, away } = get();
  const a = parseZec(amt);
  if (follower || away || !storeId || !lp || !thor || !a || thor.addPaused) {
    return;
  }
  if (shieldedZat === undefined || a + ADD_FEES > shieldedZat) {
    set({
      error:
        'this is more than this pocket holds shielded, with the network fees · nothing was sent',
    });
    return;
  }
  const { q } = quoteNow(a);
  await begin(
    storeId,
    startFlight('add', a, ADD_MEMO, {
      owner: storeId,
      unitsBefore: (thor.position?.units ?? 0n).toString(),
      costPct: q?.costPct,
    }),
  );
};

/** the ask a take-out would pay now, or undefined when the dust is past the caps */
export const askOf = (s: Pick<LpState, 'thor' | 'dustAtOpen'>): bigint | undefined => {
  const dust = s.thor?.inbound?.dust;
  return dust === undefined ||
    (s.dustAtOpen !== undefined && s.dustAtOpen > 0n && dust > s.dustAtOpen * 10n)
    ? undefined
    : askZat(dust);
};

/** take out: the ask, from the lp address, for `part` of the position */
export const startWithdraw = async () => {
  const { storeId, lp, thor, part, follower, away } = get();
  const p = positionOf({ thor });
  if (follower || away || !storeId || !lp || !thor || !p || thor.outPaused || !thor.inbound) {
    return;
  }
  const ask = askOf(get());
  if (!ask) {
    set({ error: ASK_CAP_LINE });
    return;
  }
  const bps = part * 100;
  await begin(
    storeId,
    startFlight('withdraw', ask, withdrawMemo(bps), {
      owner: storeId,
      bps,
      // what lands at the lp address: the payout after the pool's own fee
      expectZat: afterFee(
        withdrawZec(thor.pool, p.units, bps, thor.minSlipBps),
        thor.inbound.outboundFee,
      ).toString(),
    }),
  );
};

/** an add's quote against the pool as last read */
const quoteNow = (a: bigint) => {
  const { thor, zecUsd } = get();
  return {
    q: thor
      ? quoteAdd(thor.pool, a, zecUsd ? { zec: zecUsd, rune: thor.runeUsd } : undefined)
      : undefined,
  };
};

/** a price that moved this much against the person since the confirm asks again */
const MOVED_PP = 1;

/**
 * The person said continue (after the password) on a flight waiting from
 * before this tab, or on a stopped step: read the pool and vault again, and
 * for an add compare its cost with the one confirmed; a worse price is shown
 * and needs a second continue. The vault and pauses are read once more right
 * before the send itself (drive.ts).
 */
export const continueFlight = async () => {
  const { storeId, lp, moved, follower } = get();
  if (follower || !storeId || !lp) {
    return;
  }
  await reload();
  const flight = get().flight;
  if (!flight || isDone(flight)) {
    return;
  }
  await refresh();
  const t = get().thor;
  if (!t) {
    set({ error: 'thornode did not answer · nothing was sent' });
    return;
  }
  if (flight.kind === 'add' && needs({ ...flight, error: undefined }) === 'send') {
    const now = quoteNow(BigInt(flight.amountZat)).q?.costPct;
    const was = flight.costPct;
    if (!moved && now !== undefined && now > (was ?? 0) + MOVED_PP) {
      set({ moved: { was, now } });
      return;
    }
  }
  if (flight.kind === 'withdraw' && flight.stage === 'ask' && !positionOf({ thor: t })) {
    set({ error: 'nothing is left to take out at this address · nothing was sent' });
    return;
  }
  set({ confirmed: flight.id, moved: undefined, error: undefined });
  if (flight.error) {
    // a moved vault is paid only after this continue: the pin is dropped and taken again
    await changeFlight(storeId, f =>
      f?.id === flight.id
        ? { ...f, error: undefined, vault: f.error === VAULT_MOVED_LINE ? undefined : f.vault }
        : false,
    );
  }
  await runFlight();
};

/**
 * Cancel before the pool got anything: dropped, or shielded back from the
 * lp address. Decided on the stored flight under the lock, so it wins over a
 * turn that has not yet marked its send; one already marked out is refused.
 */
export const cancelAndShieldBack = async () => {
  const { flight, storeId, lp, follower } = get();
  if (follower || !flight || !storeId || !lp) {
    return;
  }
  let late = false;
  const next = await changeFlight(storeId, f => {
    if (f?.id !== flight.id || !cancellable(f)) {
      late = true;
      return false;
    }
    return cancelFlight(f);
  });
  if (late) {
    await reload();
    set({ error: CANCEL_LATE_LINE });
    return;
  }
  set({ flight: next, confirmed: next?.id, moved: undefined, error: undefined });
  if (!next) {
    set({ view: null });
    void refresh();
    return;
  }
  await runFlight();
};

/** a refunded add, or a payout at the lp address: shield it back now (the person confirmed) */
export const shieldItBack = async () => {
  const { flight, storeId, lp, follower } = get();
  if (!follower && flight && storeId && lp) {
    set({ confirmed: flight.id });
    await changeFlight(storeId, f => (f?.id === flight.id ? shieldRefund(f) : false));
    await runFlight();
  }
};

/** the tracker's last button: forget a finished (or kept, or late) flight */
export const finish = async () => {
  const { storeId, flight, follower } = get();
  set({ flight: undefined, view: null, confirmed: undefined, moved: undefined, error: undefined });
  if (storeId && !follower) {
    await changeFlight(storeId, f => (!f || f.id === flight?.id ? undefined : false));
  }
  await reload();
  void refresh();
};

/** the pocket's rune account, only while the opt-in is on and its address known */
const runeOn = () => {
  const r = get().rune;
  return r?.on && r.address ? r : undefined;
};

/** this page's wallet: for the cold choice and its viewing key */
const boundWallet = () => {
  const s = useStore.getState();
  const k = s.keyRing.keyInfos.find(x => x.id === get().keyId);
  return { key: k, zcash: selectActiveZcashWallet(s) };
};

/** a cold wallet (no phrase in zafu) chooses where its rune key comes from; a hot one never does */
export const isColdKey = (type?: string) => !!type && type !== 'mnemonic';

/** the wallet's unified viewing key string, exactly as stored (the fvk source's input) */
const viewingKey = (): string | undefined => {
  const z = boundWallet().zcash;
  return z?.ufvk ?? (z?.orchardFvk?.startsWith('uview') ? z.orchardFvk : undefined);
};

/** what the worker opens for this pocket's rune key: the sealed seed, the sealed random key, or the viewing key */
const runeKeyIn = async (rune: LpRune): Promise<ThorKeyIn> => {
  const away = awayLine();
  if (away) {
    throw new Error(away);
  }
  if (rune.source === 'seed') {
    return { source: 'seed', vault: await vaultOf() };
  }
  if (rune.source === 'random') {
    if (!rune.box) {
      throw new Error('this rune key could not be opened · nothing was sent');
    }
    return { source: 'random', vault: useStore.getState().keyRing.getBoxUnlock(rune.box) };
  }
  const fvk = viewingKey();
  if (!fvk) {
    throw new Error("this wallet's viewing key is not here · nothing was sent");
  }
  return { source: 'fvk', fvk };
};

/** derive the thor1 for the pocket's rune index in the worker, and keep it on the record */
const deriveRune = async () => {
  const { storeId, rune } = get();
  if (!storeId || !rune?.on) {
    return;
  }
  const address = await thorAddressInWorker(await runeKeyIn(rune), rune.index);
  await changeLp(book => {
    const p = book[storeId];
    return p?.rune?.on && p.rune.index === rune.index
      ? { ...book, [storeId]: { ...p, rune: { ...p.rune, address } } }
      : book;
  });
  set({ rune: { ...rune, address } });
};

let runeReads = 0;
/** the thor1's balance, account and paired position; nothing without the opt-in or with thornode off */
export const refreshRune = async () => {
  const r = runeOn();
  if (!r || !get().egress.thornode) {
    return;
  }
  const n = ++runeReads;
  try {
    const read = await readRune(r.address!);
    if (n === runeReads && runeOn()?.address === read.address) {
      set({ runeRead: read, runeErr: undefined });
    }
  } catch (e) {
    if (n === runeReads) {
      set({ runeErr: lineOf(e) });
    }
  }
};

/**
 * "add with rune too": the one step that makes this pocket's rune account.
 * Its index comes from the counter (or the one it had before), the thor1 is
 * derived in the worker, and only then is anything about it read.
 */
export const chooseRune = async () => {
  const { storeId, follower, away } = get();
  if (follower || away || !storeId) {
    return;
  }
  await ensureLpAddress();
  if (!get().lp) {
    set({ error: 'the lp address is not ready yet · please try again in a moment' });
    return;
  }
  const cold = isColdKey(boundWallet().key?.type);
  const source: RuneSource = cold ? get().runeChoice : 'seed';
  const r = await optInRune(storeId, source, async () => {
    // made only now, at the opt-in, and sealed at once like a seed
    const hex = randomThorKeyHex();
    return useStore.getState().keyRing.sealSecret(hex);
  });
  if (!r) {
    return;
  }
  set({ rune: r, error: undefined });
  try {
    if (!r.address) {
      await deriveRune();
    }
  } catch (e) {
    set({ error: lineOf(e) });
    return;
  }
  await refreshRune();
};

/** may the person stop using rune here: nothing two-sided in the pool, waiting, or on its way */
export const mayStopRune = (s: Pick<LpState, 'rune' | 'runeRead' | 'flight'>): boolean =>
  !!s.rune?.on &&
  !!s.runeRead &&
  !pairedLive(s.runeRead.paired) &&
  !(s.flight && isPaired(s.flight) && !isDone(s.flight));

/** "stop using rune here": the opt-in is forgotten and nothing more is read; the index stays for later */
export const stopRune = async () => {
  const { storeId, follower } = get();
  if (follower || !storeId || !mayStopRune(get())) {
    return;
  }
  await optOutRune(storeId);
  runeReads++;
  set({
    rune: get().rune && {
      index: get().rune!.index,
      on: false,
      source: get().rune!.source,
      ...(get().rune!.box ? { box: get().rune!.box } : {}),
    },
    runeRead: undefined,
    runeErr: undefined,
    swapQuote: undefined,
    view: 'add',
  });
};

/** sign in the worker, simulate, broadcast: one rune MsgDeposit from the pocket's thor1 */
const runeSend = async (memo: string, rune: bigint): Promise<string> => {
  const r = runeOn();
  if (!r) {
    throw new Error('this pocket does not use rune here · nothing was sent');
  }
  const read = await readRune(r.address!);
  if (!read.account) {
    throw new Error(NO_ACCOUNT_LINE);
  }
  if (rune + read.fee > read.balance) {
    throw new Error(
      'your rune address holds less than this needs with its network fee · nothing was sent',
    );
  }
  const tx = await signThorDepositInWorker(await runeKeyIn(r), {
    index: r.index,
    expected: r.address!,
    rune: rune.toString(),
    memo,
    accountNumber: read.account.accountNumber,
    sequence: read.account.sequence,
  });
  const { txhash } = await sendRuneTx(tx);
  if (!txhash) {
    throw new Error('thorchain did not take the rune deposit · nothing was sent');
  }
  void refreshRune();
  return txhash;
};

/** the rune the add would carry, at the pool ratio last read */
export const runeHalfOf = (s: Pick<LpState, 'amt' | 'thor'>): bigint | undefined => {
  const a = parseAmount(s.amt);
  return a && s.thor ? runeFor(s.thor.pool, a) : undefined;
};

/** what the thor1 must hold for the add: the rune half, its fee, and the reserve kept back */
export const runeNeedOf = (s: Pick<LpState, 'amt' | 'thor' | 'runeRead'>): bigint | undefined => {
  const half = runeHalfOf(s);
  const fee = s.runeRead?.fee ?? RUNE_FEE;
  return half === undefined ? undefined : half + fee + reserveOf(fee);
};

/** add with rune too: the person confirmed; the rune half goes first, then the zec half */
export const startAdd2 = async () => {
  const { storeId, lp, thor, amt, shieldedZat, follower, away, runeRead } = get();
  const r = runeOn();
  const a = parseAmount(amt);
  if (follower || away || !storeId || !lp || !thor || !a || !r || thor.addPaused) {
    return;
  }
  if (shieldedZat === undefined || a + ADD_FEES > shieldedZat) {
    set({
      error:
        'this is more than this pocket holds shielded, with the network fees · nothing was sent',
    });
    return;
  }
  // a half already waiting would pair with this add's zec, and this rune would be left waiting
  if (runeRead?.paired && (runeRead.paired.pendingRune > 0n || runeRead.paired.pendingAsset > 0n)) {
    set({ error: HALF_WAITING_LINE });
    return;
  }
  const half = runeFor(thor.pool, a);
  const need = runeNeedOf(get());
  if (!runeRead || need === undefined || runeRead.balance < need) {
    set({ error: 'your rune address holds less than this needs · nothing was sent' });
    return;
  }
  await begin(
    storeId,
    startFlight('add2', a, pairedAddMemo(r.address!), {
      owner: storeId,
      thor: r.address,
      runeBase: half.toString(),
      unitsBefore: (runeRead.paired?.units ?? 0n).toString(),
    }),
  );
};

export const setPayoutAs = (payoutAs: PayoutAs) => set({ payoutAs });

/** take out a two-sided position: asked from the thor1 with 0 rune */
export const startWithdraw2 = async () => {
  const { storeId, thor, part, payoutAs, follower, away, runeRead } = get();
  const r = runeOn();
  const p = runeRead?.paired;
  if (follower || away || !storeId || !thor || !r || !p || p.units === 0n || thor.outPaused) {
    return;
  }
  if (runeRead.balance < runeRead.fee) {
    set({ error: 'your rune address needs its network fee to ask · nothing was sent' });
    return;
  }
  const bps = part * 100;
  const pays = pairedWithdraw(thor.pool, p.units, bps, thor.minSlipBps, payoutAs);
  const now = Date.now();
  await begin(
    storeId,
    startFlight('withdraw2', 0n, pairedWithdrawMemo(bps, payoutAs), {
      owner: storeId,
      thor: r.address,
      payoutAs,
      bps,
      stage: 'ask',
      at: { ask: now },
      unitsBefore: p.units.toString(),
      expectZat: afterFee(pays.zat, thor.inbound?.outboundFee ?? 0n).toString(),
      expectRune: pays.rune.toString(),
    }),
  );
};

/**
 * A half that waits for the other, taken back at the person's word, from the
 * thor1: pending rune returns there, pending zec to the lp address, which is
 * then shielded back.
 */
export const startRecover = async () => {
  const { storeId, follower, away, runeRead, flight } = get();
  const r = runeOn();
  const p = runeRead?.paired;
  if (follower || away || !storeId || !r || !p || p.units > 0n) {
    return;
  }
  if (p.pendingRune === 0n && p.pendingAsset === 0n) {
    return;
  }
  if (flight && !isDone(flight) && flight.kind === 'add2') {
    set({ confirmed: flight.id });
    await changeFlight(storeId, f => (f?.id === flight.id ? recoverHalf(f) : false));
    await runFlight();
    return;
  }
  const now = Date.now();
  await begin(
    storeId,
    startFlight('add2', 0n, RECOVER_MEMO, {
      owner: storeId,
      thor: r.address,
      stage: 'recover',
      at: { recover: now },
      runeTxid: p.pendingTxId ?? 'pending',
      // zec that was waiting comes back to the lp address, and is shielded
      ...(p.pendingAsset > 0n ? { outZat: p.pendingAsset.toString() } : {}),
    }),
  );
};

export const setSwapAmt = (swapAmt: string) =>
  set({ swapAmt, swapQuote: undefined, swapErr: undefined });

/** the zec that buys what the add still needs in rune, about, at the pool ratio and a little over */
export const swapGuessOf = (s: Pick<LpState, 'amt' | 'thor' | 'runeRead'>): bigint | undefined => {
  const need = runeNeedOf(s);
  if (need === undefined || !s.thor || !s.runeRead) {
    return undefined;
  }
  const short = need - s.runeRead.balance;
  return short > 0n ? (zecFor(s.thor.pool, short) * 103n) / 100n + 1_000n : 0n;
};

let quotes = 0;
/** a fresh zec -> rune quote for what is typed; only the newest is kept */
export const quoteSwap = async () => {
  const r = runeOn();
  const zat = parseAmount(get().swapAmt);
  if (!r || !zat || !get().egress.thornode) {
    set({ swapQuote: undefined });
    return;
  }
  const n = ++quotes;
  try {
    const q = await quoteRune(zat, r.address!);
    if (n === quotes) {
      set({ swapQuote: q, swapErr: undefined });
    }
  } catch (e) {
    if (n === quotes) {
      set({ swapQuote: undefined, swapErr: lineOf(e) });
    }
  }
};

/** swap zec for rune to the thor1: the same shield-out and t-address deposit an add makes */
export const startRuneSwap = async () => {
  const { storeId, lp, swapQuote: q, shieldedZat, follower, away } = get();
  const r = runeOn();
  if (follower || away || !storeId || !lp || !r || !q) {
    return;
  }
  if (q.expiry <= Date.now()) {
    set({ swapQuote: undefined, swapErr: 'this quote expired · please ask again' });
    return;
  }
  if (shieldedZat === undefined || q.amountZat + ADD_FEES > shieldedZat) {
    set({
      swapErr:
        'this is more than this pocket holds shielded, with the network fees · nothing was sent',
    });
    return;
  }
  await begin(
    storeId,
    startFlight('swap', q.amountZat, q.memo, {
      owner: storeId,
      thor: r.address,
      expectRune: q.runeOut.toString(),
      vault: q.vault,
    }),
  );
  set({ swapQuote: undefined, swapAmt: '' });
};

export const setRuneChoice = (runeChoice: LpState['runeChoice']) => set({ runeChoice });
