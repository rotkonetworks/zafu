/**
 * tools - everything that isn't a balance, a message or a setting, in one
 * screen. tiles are gated per network (see config/networks.ts); the
 * "everywhere" rows below are not.
 */

import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { isIdentityEnabled } from '../../../state/privacy';
import { hasFeature } from '../../../config/networks';
import { IRONWOOD_MIGRATION } from '../../../config/feature-flags';
import { PopupPath } from '../paths';
import { screenTransition } from '../../../utils/navigate';

interface Tile {
  icon: string;
  label: string;
  desc: string;
  path: string;
}

export const ToolsPage = () => {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const identityEnabled = useStore(isIdentityEnabled);

  const go = (path: string) => navigate(path, screenTransition('push'));

  const tiles: Tile[] = [
    identityEnabled && {
      icon: 'i-ph-password',
      label: 'passwords',
      desc: 'sign in with zafu',
      path: PopupPath.PASSWORDS,
    },
    hasFeature(activeNetwork, 'vote') && {
      icon: 'i-zafu-sensu',
      label: 'vote',
      desc: 'governance',
      path: PopupPath.VOTE,
    },
    hasFeature(activeNetwork, 'swap') && {
      icon: 'i-ph-arrows-left-right',
      label: 'swap',
      desc: `${activeNetwork} · other chains`,
      path: PopupPath.SWAP,
    },
    hasFeature(activeNetwork, 'stake') && {
      icon: 'i-ph-coins',
      label: 'stake',
      desc: activeNetwork,
      path: PopupPath.STAKE,
    },
    hasFeature(activeNetwork, 'multisig') && {
      icon: 'i-zafu-torii',
      label: 'multisig',
      desc: 'threshold wallets',
      path: PopupPath.MULTISIG,
    },
    IRONWOOD_MIGRATION &&
      hasFeature(activeNetwork, 'zcash') && {
        icon: 'i-zafu-mon',
        label: 'pool notes',
        desc: 'orchard · ironwood',
        path: PopupPath.POOL_NOTES,
      },
  ].filter(Boolean) as Tile[];

  const everywhere: Tile[] = [
    {
      icon: 'i-ph-plug',
      label: 'connected sites',
      desc: '',
      path: PopupPath.SETTINGS_CONNECTED_SITES,
    },
    hasFeature(activeNetwork, 'zcash') && {
      icon: 'i-ph-arrows-left-right',
      label: 'sync to zigner',
      desc: '',
      path: PopupPath.NOTE_SYNC,
    },
  ].filter(Boolean) as Tile[];

  return (
    <div className='flex flex-col gap-6 p-4'>
      {tiles.length > 0 && (
        <section className='flex flex-col gap-2'>
          <h2 className='kicker'>{activeNetwork}</h2>
          <div className='grid grid-cols-2 gap-2'>
            {tiles.map(t => (
              <button
                key={t.path}
                onClick={() => go(t.path)}
                className={cn(
                  'flex h-[104px] flex-col justify-between border border-surface-border-soft',
                  'bg-surface-elev-1 p-3.5 text-left transition-colors hover:bg-surface-elev-2',
                )}
              >
                <span className={cn(t.icon, 'size-6 text-zigner-gold')} aria-hidden='true' />
                <span className='flex flex-col gap-0.5'>
                  <span className='text-data text-fg-high lowercase'>{t.label}</span>
                  {t.desc && <span className='text-label text-fg-muted lowercase'>{t.desc}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className='flex flex-col gap-2'>
        <h2 className='kicker'>everywhere</h2>
        <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
          {everywhere.map(t => (
            <button
              key={t.path}
              onClick={() => go(t.path)}
              className='flex min-h-[52px] items-center gap-3 px-3.5 text-left transition-colors hover:bg-surface-elev-2'
            >
              <span className={cn(t.icon, 'size-5 shrink-0 text-fg-muted')} aria-hidden='true' />
              <span className='flex-1 text-data text-fg-high lowercase'>{t.label}</span>
              <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
