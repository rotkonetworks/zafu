/**
 * network sheet - pick the active network, or turn one on. Lists every
 * launched top-level network (not just the enabled ones), so a disabled
 * network still shows up with a "turn on" row instead of being invisible.
 *
 * Zcash testnet is an entry of its own, right under zcash: picking it is
 * picking zcash with its testnet switch on (a seed wallet's zcash then speaks
 * testnet; mainnet waits untouched, and only the chain in use syncs), and
 * picking zcash turns the switch off. The mark follows the chain shown.
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
  selectSetActiveNetwork,
} from '../state/keyring';
import { selectNetworkShown } from '../state/wallets';
import { useEnableNetwork } from '../hooks/enable-network';
import { getNetwork, getSubnetworks, getTopLevelNetworks } from '../config/networks';
import { PopupPath } from '../routes/popup/paths';

/** one line per network, so the pools read apart at a glance */
export const NETWORK_BLURB: Partial<Record<string, string>> = {
  zcash: 'encrypted money',
  'zcash-testnet': 'coins have no value',
  penumbra: 'private defi',
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
  const testnetOn = enabledNetworks.includes('zcash-testnet');

  /** zcash, then its testnet as an entry of its own, then the rest */
  const entries = getTopLevelNetworks().flatMap(n =>
    n === 'zcash' ? [n, ...getSubnetworks(n)] : [n],
  );

  const pick = async (n: (typeof enabledNetworks)[number]) => {
    onOpenChange(false);
    if (n === shown) {
      return;
    }
    if (n === 'zcash-testnet') {
      if (!enabledNetworks.includes('zcash')) {
        await toggleNetwork('zcash');
      }
      if (!testnetOn) {
        await toggleNetwork('zcash-testnet');
      }
      await setActiveNetwork('zcash');
    } else {
      // zcash itself is mainnet: leaving testnet turns its switch off
      if (n === 'zcash' && testnetOn) {
        await toggleNetwork('zcash-testnet');
      }
      await setActiveNetwork(n);
    }
    // always land on home - the previous sub-page may not exist on the
    // newly selected network
    navigate(PopupPath.INDEX);
  };

  const turnOn = async (n: (typeof enabledNetworks)[number]) => {
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
        const blurb =
          sub && !seed
            ? 'for seed wallets · a signer wallet keeps its own chain'
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
