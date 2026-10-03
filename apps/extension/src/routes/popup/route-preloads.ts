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
import { activeZcashStoreId } from '../../state/pockets';
import { selectActiveZcashWallet } from '../../state/wallets';
import { checkEgress } from '../../net/egress';
import { getRootNetwork } from '../../config/networks';
import { balancesQueryOptions } from '../../hooks/penumbra-balances';
import { zcashWorkerQuery } from '../../hooks/zcash-pool-balances';
import { activeTransparentAddressesQuery } from '../../hooks/use-transparent-addresses';
import { penumbraHistoryQuery, zcashHistoryQuery } from './home/history';
import { zidPinsQuery } from './identity/use-identity';
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

/** the active pocket's worker figures: balance, pools, in-flight sends */
const zcashFigures: Preload = ({ client, state }) => {
  const store = activeZcashStoreId(state);
  if (!isZcash(state) || !store) {
    return;
  }
  for (const q of [zcashWorkerQuery.balance, zcashWorkerQuery.pools, zcashWorkerQuery.pending]) {
    void client.prefetchQuery(q(store) as Parameters<typeof client.prefetchQuery>[0]);
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
   * zcash the transparent refund address and the spendable notes). Quotes are
   * the swap screen's own and plug in beside this through
   * `registerRoutePreload(PopupPath.SWAP, ...)` - only for routes already allowed.
   */
  swap: all(penumbraBalances, ({ client, state }) => {
    const store = activeZcashStoreId(state) ?? selectEffectiveKeyInfo(state)?.id;
    return (
      isZcash(state) &&
      Promise.all([
        client.prefetchQuery(activeTransparentAddressesQuery(state, true)),
        client.prefetchQuery(zcashWorkerQuery.notes(store)),
      ])
    );
  }),
  /** "you": the active wallet's named identities */
  identity: ({ client, state }: PreloadCtx) =>
    client.prefetchQuery(zidPinsQuery(selectEffectiveKeyInfo(state)?.id ?? '')),
  /** the wallets panel (a sheet): the active pocket's figure, as home reads it */
  wallets: zcashFigures,
} satisfies Record<string, Preload>;
