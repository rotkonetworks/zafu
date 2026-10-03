/**
 * The data side of each route's preload (see preload.ts): the queries a screen
 * reads first, warmed with the very options the screen reads them by.
 *
 * Every read here is local - the view service, the zcash worker, storage -
 * except history, which asks the network's own light-client server. That one
 * runs only when the screen itself would ask it at once (history kept, the
 * server allowed right now), and never asks to allow anything.
 */

import type { AllSlices } from '../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
} from '../../state/keyring';
import { activePockets, activeZcashStoreId, visiblePockets } from '../../state/pockets';
import { pocketStoreId } from '../../state/pocket-id';
import { selectActiveZcashWallet } from '../../state/wallets';
import { checkEgress } from '../../net/egress';
import { getRootNetwork } from '../../config/networks';
import { balancesQueryOptions } from '../../hooks/penumbra-balances';
import { zcashWorkerQuery } from '../../hooks/zcash-pool-balances';
import { activeTransparentAddressesQuery } from '../../hooks/use-transparent-addresses';
import { penumbraHistoryQuery, zcashHistoryQuery } from './home/history';
import { zidPinsQuery } from './identity/use-identity';
import { swapWallet } from '../../hooks/swap-preload';
import { preloadSwapQuote } from '../../state/swap/preload';
import type { Preload, PreloadCtx } from './route-modules';

const zidecarOf = (s: AllSlices) => s.networks.networks.zcash.endpoint || 'https://zcash.rotko.net';
const isZcash = (s: AllSlices) => selectActiveNetwork(s) === 'zcash';
const isPenumbra = (s: AllSlices) => getRootNetwork(selectActiveNetwork(s)) === 'penumbra';

/** penumbra's raw balances, the one cache home, send, swap and the token sheet read */
const penumbraBalances: Preload = ({ client, state }) =>
  isPenumbra(state) &&
  client.prefetchQuery({
    ...balancesQueryOptions(selectPenumbraAccount(state)),
    staleTime: 30_000,
  });

/** a pocket store's worker figures: balance, pools, in-flight sends (all local) */
const figuresOf = ({ client }: PreloadCtx, store: string | undefined) => {
  for (const q of [zcashWorkerQuery.balance, zcashWorkerQuery.pools, zcashWorkerQuery.pending]) {
    void client.prefetchQuery(q(store) as Parameters<typeof client.prefetchQuery>[0]);
  }
};

/** the active pocket's figures */
const zcashFigures: Preload = ctx =>
  isZcash(ctx.state) && figuresOf(ctx, activeZcashStoreId(ctx.state));

/**
 * The wallets panel: every pocket it lists, so picking one shows its own
 * figures at once. Local worker reads only - a pocket's transparent UTXOs ask
 * the light-client server, which the panel itself never does, so they are not
 * fetched ahead; home holds the last figure, dimmed, while they come.
 */
const everyPocket: Preload = ctx => {
  const key = selectEffectiveKeyInfo(ctx.state);
  if (!isZcash(ctx.state) || key?.type !== 'mnemonic') {
    void zcashFigures(ctx);
    return;
  }
  for (const account of new Set([
    0,
    ...visiblePockets(activePockets(ctx.state)).map(p => p.account),
  ])) {
    figuresOf(ctx, pocketStoreId(key.id, account));
  }
};

/** the history list, only where it is kept and its server may be asked right now */
const history = async ({ client, state }: PreloadCtx) => {
  if (!state.privacy.settings.enableTransactionHistory) {
    return;
  }
  if (isPenumbra(state)) {
    return client.prefetchQuery(penumbraHistoryQuery(selectPenumbraAccount(state), true));
  }
  const zidecar = zidecarOf(state);
  if (!isZcash(state) || !checkEgress(zidecar).allow) {
    return;
  }
  const isMainnet = !zidecar.includes('testnet');
  const { tAddresses } = await client.ensureQueryData(
    activeTransparentAddressesQuery(state, isMainnet),
  );
  return client.prefetchQuery(
    zcashHistoryQuery(activeZcashStoreId(state), zidecar, tAddresses, true),
  );
};

/** the transparent addresses receive shows, keyed as receive reads them (local derivation, cached) */
const tAddresses: Preload = ({ client, state }) =>
  isZcash(state) &&
  client.prefetchQuery(
    activeTransparentAddressesQuery(state, selectActiveZcashWallet(state)?.mainnet ?? true),
  );

const all =
  (...preloads: Preload[]): Preload =>
  ctx =>
    Promise.all(preloads.map(p => p(ctx)));

export const routePreloads = {
  /** home, both networks: the hero figures and the newest activity */
  home: all(penumbraBalances, zcashFigures, history),
  activity: history,
  send: all(penumbraBalances, zcashFigures),
  /**
   * receive: chunk and the transparent addresses only. The shielded address is
   * never derived ahead: arriving rotates it and leaving retires it, so a
   * preload would burn a diversifier the person never saw.
   */
  receive: tAddresses,
  /**
   * swap entry: the local reads the screen opens on (penumbra balances; on
   * zcash the transparent refund address and the spendable notes), and the
   * swap's own price preload: the last prices it was shown, put back from
   * session memory, and a fresh quote from routes already allowed - a route
   * not yet allowed is never asked (state/swap/preload.ts).
   */
  swap: all(penumbraBalances, ({ client, state }) => {
    const wallet = swapWallet(state);
    return (
      isZcash(state) &&
      Promise.all([
        client.prefetchQuery(activeTransparentAddressesQuery(state, true)),
        client.prefetchQuery(zcashWorkerQuery.notes(wallet)),
        wallet && preloadSwapQuote({ client, wallet }),
      ])
    );
  }),
  /** "you": the active wallet's named identities */
  identity: ({ client, state }: PreloadCtx) =>
    client.prefetchQuery(zidPinsQuery(selectEffectiveKeyInfo(state)?.id ?? '')),
  /** the wallets panel (a sheet): every listed pocket's figures */
  wallets: everyPocket,
} satisfies Record<string, Preload>;
