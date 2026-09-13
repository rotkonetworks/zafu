/**
 * In-context zcash.me opt-in.
 *
 * Shown where the directory would have helped right now: a "/name" typed
 * into the recipient field, a search with no local match, the top of the
 * address book. It explains what the feature does and, per mode, exactly
 * what zcash.me learns, and lets the user pick a mode without leaving the
 * screen. "not now" is remembered so passive placements stop nagging; the
 * explicit "/name" placement keeps offering, since the user clearly wants
 * the lookup.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../routes/popup/paths';
import { DEFAULT_LIVE_DECOYS, useZcashMe, writeZcashMeConfig } from '../services/zcashme/config';
import { cn } from '@repo/ui/lib/utils';

interface Props {
  /** what the user was trying to do, e.g. 'pay /alice' or 'find people' */
  reason: string;
  /** passive placements honour a previous "not now"; explicit ones do not */
  respectDismissal?: boolean;
  className?: string;
}

export function ZcashMeOptIn({ reason, respectDismissal = true, className }: Props) {
  const navigate = useNavigate();
  const { config } = useZcashMe();
  const [busy, setBusy] = useState(false);

  if (!config || config.mode !== 'off' || (respectDismissal && config.promptDismissed)) {
    return null;
  }

  const choose = async (mode: 'directory' | 'live') => {
    setBusy(true);
    // seed a sane decoy count the first time live mode is picked, so a bare
    // name is not sent by default; the user can still drag it to 0
    const decoys = mode === 'live' && config.decoys === 0 ? DEFAULT_LIVE_DECOYS : config.decoys;
    await writeZcashMeConfig({ ...config, mode, decoys, promptDismissed: true });
    setBusy(false);
    if (mode === 'directory') {
      // a snapshot source is required before local lookups answer anything
      navigate(PopupPath.SETTINGS_ZCASHME);
    }
  };

  const dismiss = async () => {
    await writeZcashMeConfig({ ...config, promptDismissed: true });
  };

  return (
    <div className={cn('rounded-lg border border-border-soft bg-elev-1 p-3', className)}>
      <div className='mb-1.5 flex items-center gap-2'>
        <span className='i-ph-address-book h-4 w-4 shrink-0 text-network-accent' />
        <p className='text-xs text-fg-high'>use the zcash.me directory to {reason}?</p>
      </div>
      <p className='text-label text-fg-muted'>
        zcash.me maps usernames and verified x / github / telegram handles to zcash addresses. with
        it on, you can pay /username and the wallet can name addresses you already paid. it is off
        because both ways of using it tell zcash.me something:
      </p>
      <ul className='mt-1.5 flex flex-col gap-1 text-label text-fg-muted'>
        <li className='flex gap-1.5'>
          <span className='i-ph-download-simple mt-0.5 h-3 w-3 shrink-0 text-fg-dim' />
          <span>
            <span className='text-fg-high'>local directory</span> downloads the whole list once.
            zcash.me learns your ip and that you use the feature, never which names you look up.
            needs a mirror url or an api key.
          </span>
        </li>
        <li className='flex gap-1.5'>
          <span className='i-ph-broadcast mt-0.5 h-3 w-3 shrink-0 text-amber-400' />
          <span>
            <span className='text-fg-high'>live lookup</span> asks zcash.me per name. it sees your
            ip; add decoy cover in settings so it cannot tell which name you want, though repeat
            lookups can still be correlated across sessions.
          </span>
        </li>
      </ul>
      <div className='mt-2 flex gap-2'>
        <button
          type='button'
          disabled={busy}
          onClick={() => void choose('directory')}
          className='flex-1 rounded-lg bg-network-accent py-1.5 text-xs font-medium text-network-accent-foreground hover:opacity-90 disabled:opacity-50'
        >
          local directory
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => void choose('live')}
          className='flex-1 rounded-lg border border-border-soft py-1.5 text-xs text-fg-muted hover:text-fg-high disabled:opacity-50'
        >
          live lookup
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => void dismiss()}
          className='rounded-lg px-2 py-1.5 text-xs text-fg-dim hover:text-fg-high disabled:opacity-50'
        >
          not now
        </button>
      </div>
      <p className='mt-1.5 text-label text-fg-dim'>
        change this any time in settings, zcash.me directory.
      </p>
    </div>
  );
}
