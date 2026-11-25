/**
 * network sheet - pick the active network, or turn one on. Lists every
 * launched top-level network (not just the enabled ones), so a disabled
 * network still shows up with a "turn on" row instead of being invisible.
 *
 * A network's testnet (zcash's, penumbra's) is an entry of its own, right
 * under it: picking it is picking the network with its testnet switch on (it
 * then speaks testnet; mainnet waits untouched, and only the chain in use
 * syncs), and picking the network turns the switch off. The mark follows the
 * chain shown. A penumbra testnet has no node until the person sets one.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../state';
import {
  selectEffectiveKeyInfo,
  selectEnabledNetworks,
  selectKeyInfos,
  selectSelectedKeyInfo,
  selectSetActiveNetwork,
  type NetworkType,
} from '../state/keyring';
import { findCompatibleVault, keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import { selectNetworkShown } from '../state/wallets';
import { useEnableNetwork } from '../hooks/enable-network';
import { getNetwork, getTopLevelNetworks, testnetOf } from '../config/networks';
import { PopupPath } from '../routes/popup/paths';
import { useBetaFeatures } from '../config/beta';

/** one line per network, so the pools read apart at a glance */
export const NETWORK_BLURB: Partial<Record<string, string>> = {
  zcash: 'encrypted money',
  'zcash-testnet': 'coins have no value',
  penumbra: 'private defi',
  'penumbra-testnet': 'coins have no value · your own node',
  hyperliquid: 'beta · usdc in and out, public',
};

export const NetworkSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();
  const shown = useStore(selectNetworkShown);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  /** testnet is a seed wallet's: a zigner or multisig wallet's chain is in its key */
  const seed = useStore(s => selectEffectiveKeyInfo(s)?.type === 'mnemonic');
  const enable = useEnableNetwork();
  const selected = useStore(selectSelectedKeyInfo);
  const keyInfos = useStore(selectKeyInfos);
  /** the wallet setActiveNetwork moves to when the selected one can't serve `n` */
  const switchesTo = (n: (typeof enabledNetworks)[number]) =>
    selected && !keyInfoSupportsNetwork(selected, n) ? findCompatibleVault(keyInfos, n) : undefined;
  const penumbraNode = useStore(s => !!s.networks.networks['penumbra-testnet'].endpoint);

  /** each network, then its testnet as an entry of its own */
  const entries = getTopLevelNetworks(useBetaFeatures(), enabledNetworks).flatMap(n => [
    n,
    ...[testnetOf(n)].filter((t): t is NetworkType => !!t),
  ]);

  const pick = async (n: NetworkType) => {
    onOpenChange(false);
    if (n === shown) {
      return;
    }
    // a testnet is its network with the switch on; the network itself is mainnet
    const network = getNetwork(n).parent ?? n;
    const testnet = testnetOf(network);
    const want = [network, ...(testnet && n === testnet ? [testnet] : [])];
    for (const t of [network, testnet].filter((t): t is NetworkType => !!t)) {
      if (want.includes(t) !== enabledNetworks.includes(t)) {
        await toggleNetwork(t);
      }
    }
    await setActiveNetwork(network);
    // a penumbra testnet reads only the node the person sets
    navigate(
      n === 'penumbra-testnet' && !penumbraNode
        ? `${PopupPath.SETTINGS_PENUMBRA_NETWORK}?sheet=testnet`
        : // always land on home - the previous sub-page may not exist on the
          // newly selected network
          PopupPath.INDEX,
    );
  };

  const turnOn = async (n: NetworkType) => {
    await enable(n);
    onOpenChange(false);
    navigate(PopupPath.INDEX);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='networks' className='gap-0 px-3 pb-4'>
      {entries.map(n => {
        const info = getNetwork(n);
        const sub = !!info.parent;
        // the testnet entry is always there to pick (picking turns it on), for a seed wallet
        const enabled = sub ? seed : enabledNetworks.includes(n);
        const active = shown === n;
        const other = switchesTo(info.parent ?? n);
        const blurb =
          sub && !seed
            ? 'for seed wallets · a signer wallet keeps its own chain'
            : other && !active
              ? `switches to ${other.name.toLowerCase()}`
              : NETWORK_BLURB[n];
        return (
          <div key={n} className='flex h-[60px] items-center gap-3.5 px-2'>
            <button
              type='button'
              disabled={!enabled}
              onClick={() => void pick(n)}
              aria-label={`use ${info.name}`}
              className='flex min-w-0 flex-1 items-center gap-3.5 text-left disabled:cursor-default'
            >
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center',
                  enabled && 'border',
                  active ? 'border-zigner-gold' : 'border-surface-border',
                )}
                aria-hidden='true'
              >
                {active && <span className='size-2 bg-zigner-gold' />}
              </span>
              <span className={cn('size-2.5 shrink-0', info.color)} aria-hidden='true' />
              <span className='flex min-w-0 flex-col gap-[3px]'>
                <Clipped className='text-[15px] text-fg-high lowercase'>{info.name}</Clipped>
                {blurb && <Clipped className='text-[11px] text-fg-muted'>{blurb}</Clipped>}
              </span>
            </button>
            {!enabled && !sub && (
              <Button
                variant='secondary'
                size='sm'
                className='h-8 border-surface-border px-3 text-zigner-gold'
                onClick={() => void turnOn(n)}
              >
                turn on
              </Button>
            )}
          </div>
        );
      })}
      <button
        type='button'
        onClick={() => {
          onOpenChange(false);
          navigate(PopupPath.SETTINGS_DEVICES);
        }}
        className='mt-1.5 flex h-11 items-center border-t border-border-soft px-2 text-left text-label text-fg-muted'
      >
        manage networks
      </button>
    </Sheet>
  );
};
