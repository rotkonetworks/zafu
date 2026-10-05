/**
 * lp.html's one store. The flight (lp/flight.ts) is the source of truth for
 * an add or take-out on its way; this adds what the page is doing now: the
 * form, the last reads with their age, and which screen the person chose.
 * Reads run only while this tab is visible, and only to destinations the
 * person allowed on the first look.
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
  spawnNetworkWorker,
} from '../../state/keyring/network-worker';
import { refreshEgress } from '../../net/egress';
import { setDestinationOptIn } from '../../net/ledger';
import { readEgressView } from '../../net/egress-opt-in';
import { claimTAddress, tAddressAt } from '../../hooks/use-transparent-addresses';
import { drive, type DriveDeps } from '../../lp/drive';
import { isDone, needs, resumed, shieldRefund, startFlight, type Flight } from '../../lp/flight';
import {
  ADD_MEMO,
  afterFee,
  DEFAULT_ADD,
  parseZec,
  withdrawMemo,
  withdrawZec,
} from '../../lp/math';
import { changeLp, patchLpPocket, readLpPocket, type LpCache } from '../../lp/store';
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

export type View = 'add' | 'position' | 'withdraw' | 'twoSided';
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
  storeId?: string;
  pocket: string;
  lp?: { index: number; address: string };
  cache?: LpCache;
  thor?: ThorRead;
  mid?: MidgardRead;
  zecUsd?: number;
  pxAt?: number;
  /** why the last read failed, in one calm line */
  readErr?: string;
  flight?: Flight;
  shieldedZat?: bigint;
  error?: string;
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
};

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

export const init = async () => {
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
  const [rec, egress, view] = await Promise.all([
    readLpPocket(storeId),
    lpEgress(),
    readEgressView(),
  ]);
  const flight = rec?.flight && resumed(rec.flight);
  set({
    phase: 'ready',
    storeId,
    pocket,
    egress,
    blocked: view.find(d => d.id === THORNODE_DEST)?.why === 'you-blocked',
    intro: egress.thornode ? null : 'first',
    cache: rec?.cache,
    flight,
    lp: rec?.address ? { index: rec.index, address: rec.address } : undefined,
  });
  if (flight && flight !== rec?.flight) {
    await patchLpPocket(storeId, { flight });
  }
  // a restored index has no address yet: derived here, locally
  if (rec && !rec.address) {
    const address = await tAddressAt(useStore.getState(), rec.index, true);
    if (address) {
      await patchLpPocket(storeId, { address });
      set({ lp: { index: rec.index, address } });
    }
  }
  if (egress.thornode) {
    await ensureLpAddress();
    void tick();
  }
};

/** the pocket's one lp address: claimed once, from the counter swaps use */
const ensureLpAddress = async () => {
  const { storeId, lp } = get();
  if (lp || !storeId) {
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

export const goEgress = () => set({ intro: 'egress' });
export const goFirst = () => set({ intro: 'first' });

/** the ask-once list's "allow and continue": thornode, midgard and the market price */
export const allowEgress = async () => {
  for (const id of LP_EGRESS) {
    await setDestinationOptIn(id, 'allowed');
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
export const refresh = async () => {
  const { egress, lp, storeId } = get();
  if (!egress.thornode) {
    return;
  }
  const [thor, mid, zecUsd] = await Promise.all([
    readThor(lp?.address).catch((e: unknown) => {
      set({ readErr: lineOf(e) });
      return undefined;
    }),
    egress.midgard ? readMidgard(lp?.address).catch(() => undefined) : undefined,
    egress.prices ? readMarketZec().catch(() => undefined) : undefined,
  ]);
  if (thor) {
    set({ thor, readErr: undefined });
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
    await patchLpPocket(storeId, { cache });
  }
  if (storeId) {
    void spawnNetworkWorker('zcash')
      .then(() => getPoolBalancesInWorker('zcash', storeId))
      .then(b => set({ shieldedZat: b.total }))
      .catch(() => undefined);
  }
};

const vaultOf = async () => {
  const key = hotKey();
  if (!key) {
    throw new Error('this wallet cannot sign here');
  }
  return useStore.getState().keyRing.getVaultUnlock(key.id);
};

const depsOf = (storeId: string, lp: { index: number; address: string }): DriveDeps => ({
  address: lp.address,
  index: lp.index,
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
      activeAccountIndex(useStore.getState()),
      true,
      await vaultOf(),
    );
    if (!('txid' in r)) {
      throw new Error('this wallet cannot sign here');
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
  save: async f => {
    set({ flight: f });
    await patchLpPocket(storeId, { flight: f });
  },
});

let running = false;

/** turn the flight until it waits on the chain or the person */
const runFlight = async () => {
  const { flight, storeId, lp, thor } = get();
  if (running || !flight || !storeId || !lp || isDone(flight) || flight.error) {
    return;
  }
  running = true;
  try {
    await spawnNetworkWorker('zcash');
    let f = flight;
    for (let i = 0; i < 4; i++) {
      const next = await drive(f, depsOf(storeId, lp), thor?.inbound?.address ?? '');
      const moved = next.stage !== f.stage || !!next.error;
      f = next;
      if (!moved || !needs(f)) {
        break;
      }
    }
  } catch (e) {
    set({ error: lineOf(e) });
  } finally {
    running = false;
  }
};

/** what the page does each turn while visible: read, then move the flight on */
export const tick = async () => {
  await refresh();
  await runFlight();
};

export const setAmount = (amt: string) => set({ amt });
export const setPart = (part: LpState['part']) => set({ part });
export const openSheet = (sheet: Sheet | null) => set({ sheet });
export const show = (view: View | null) => set({ view, sheet: null, error: undefined });

/** add: the person confirmed; the flight starts and the tracker shows */
export const startAdd = async () => {
  const { storeId, lp, thor, amt } = get();
  const a = parseZec(amt);
  if (!storeId || !lp || !thor || !a || thor.addPaused) {
    return;
  }
  const f = startFlight('add', a, ADD_MEMO, {
    unitsBefore: (thor.position?.units ?? 0n).toString(),
  });
  set({ flight: f, view: null });
  await patchLpPocket(storeId, { flight: f });
  await runFlight();
};

/** take out: the dust ask, from the lp address, for `part` of the position */
export const startWithdraw = async () => {
  const { storeId, lp, thor, part } = get();
  const p = positionOf({ thor });
  if (!storeId || !lp || !thor || !p || thor.outPaused || !thor.inbound) {
    return;
  }
  const bps = part * 100;
  const f = startFlight('withdraw', thor.inbound.dust, withdrawMemo(bps), {
    bps,
    // what lands at the lp address: the payout after the pool's own fee
    expectZat: afterFee(
      withdrawZec(thor.pool, p.units, bps, thor.minSlipBps),
      thor.inbound.outboundFee,
    ).toString(),
  });
  set({ flight: f, view: null });
  await patchLpPocket(storeId, { flight: f });
  await runFlight();
};

/** a stopped step: the person asks it to run again */
export const retry = async () => {
  const { flight } = get();
  if (flight?.error) {
    await depsOf(get().storeId!, get().lp!).save({ ...flight, error: undefined });
    await runFlight();
  }
};

/** a refunded add: shield it back now */
export const shieldItBack = async () => {
  const { flight, storeId, lp } = get();
  if (flight && storeId && lp) {
    await depsOf(storeId, lp).save(shieldRefund(flight));
    await runFlight();
  }
};

/** the tracker's last button: forget a finished (or kept) flight */
export const finish = async () => {
  const { storeId } = get();
  set({ flight: undefined, view: null });
  if (storeId) {
    await patchLpPocket(storeId, { flight: undefined });
  }
  void refresh();
};
