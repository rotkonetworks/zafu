/**
 * zcash.me handle resolver for the recipient field.
 *
 * Renders only while the recipient input holds a handle ("/alice",
 * "zcash.me/alice"). What it does depends on the zcash.me mode:
 *
 *   off        a one-line hint pointing at settings; no network, no lookup
 *   directory  resolves from the local snapshot synchronously; one click
 *              swaps the handle for the address. Nothing leaves the wallet.
 *   live       shows a button that says plainly what the request leaks
 *              (ip + the name) and only then calls the public endpoint.
 *
 * Unverified profiles are shown with a warning and a different icon: an
 * unverified name can point at anyone's address.
 */

import { useEffect, useState } from 'react';
import { ZcashMeOptIn } from './zcashme-opt-in';
import {
  lookupZcashMe,
  lookupZcashMeWithDecoys,
  parseZcashMeHandle,
  type ZcashMeProfile,
} from '../services/zcashme/api';
import { pickDecoys } from '../services/zcashme/decoys';
import { useZcashMe } from '../services/zcashme/config';
import { useStore } from '../state';
import { privacySettingsSelector } from '../state/privacy';
import { zcashMeLabel, zcashMeUsername } from '../services/zcashme/label';
import { cn } from '@repo/ui/lib/utils';

interface Props {
  input: string;
  /** called with the resolved address + profile when the user accepts it */
  onResolve: (profile: ZcashMeProfile) => void;
}

export function ProfileBadge({ profile, compact }: { profile: ZcashMeProfile; compact?: boolean }) {
  const name = zcashMeLabel(profile);
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          profile.addressVerified
            ? 'i-ph-seal-check text-network-accent'
            : 'i-ph-warning text-amber-400',
        )}
      />
      <span className='truncate text-xs'>{name}</span>
      {!compact && (
        <span className='truncate text-label text-fg-muted'>
          zcash.me/{zcashMeUsername(profile)}
          {profile.addressVerified ? '' : ' - unverified'}
        </span>
      )}
    </span>
  );
}

export function ZcashMeRecipientResolver({ input, onResolve }: Props) {
  const handle = parseZcashMeHandle(input);
  const { config, index } = useZcashMe();
  const proxyEnabled = useStore(privacySettingsSelector).proxy.enabled;
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<{ handle: string; profile: ZcashMeProfile } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // a new handle invalidates the previous live answer
  useEffect(() => {
    setLive(null);
    setError(null);
  }, [handle]);

  if (!handle || !config) {
    return null;
  }

  const box = 'mt-1.5 rounded-lg border border-border-soft bg-elev-1 p-2';

  if (config.mode === 'off') {
    return <ZcashMeOptIn reason={`pay /${handle}`} respectDismissal={false} className='mt-1.5' />;
  }

  const local = index?.byName.get(handle.toLowerCase());
  const profile = local ?? (live?.handle === handle ? live.profile : undefined);

  const accept = (p: ZcashMeProfile) => (
    <button
      type='button'
      onClick={() => onResolve(p)}
      className='flex w-full items-center justify-between gap-2 text-left'
    >
      <ProfileBadge profile={p} />
      <span className='shrink-0 text-label text-network-accent'>use address</span>
    </button>
  );

  if (profile) {
    return (
      <div className={box}>
        {accept(profile)}
        {!profile.addressVerified && (
          <p className='mt-1 text-label text-amber-400'>
            this profile has not proven it controls the address. confirm with the person before
            sending.
          </p>
        )}
      </div>
    );
  }

  if (config.mode === 'directory') {
    return (
      <div className={box}>
        <p className='text-label text-fg-muted'>
          "/{handle}" is not in the local zcash.me directory
          {index
            ? ` (${index.snapshot.profiles.length} profiles, refresh in settings)`
            : ' (no snapshot downloaded yet)'}
          .
        </p>
      </div>
    );
  }

  // live mode
  const lookup = async () => {
    setPending(true);
    setError(null);
    // draw real decoys from the snapshot when cover is enabled and a
    // snapshot is loaded; otherwise fall back to a bare lookup
    const decoyNames = config.decoys > 0 && index ? pickDecoys(index, handle, config.decoys) : [];
    const res =
      decoyNames.length > 0
        ? await lookupZcashMeWithDecoys(handle, decoyNames, { spacingMs: 120 })
        : await lookupZcashMe(handle);
    setPending(false);
    if (res.ok) {
      setLive({ handle, profile: res.profile });
    } else {
      setError(res.message);
    }
  };

  return (
    <div className={box}>
      <button
        type='button'
        disabled={pending}
        onClick={() => void lookup()}
        className='flex w-full items-center gap-2 text-left disabled:opacity-50'
      >
        <span
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            pending ? 'i-ph-spinner animate-spin' : 'i-ph-magnifying-glass',
          )}
        />
        <span className='text-xs'>look up /{handle} on zcash.me</span>
      </button>
      <p className='mt-1 text-label text-fg-muted'>
        {config.decoys > 0 && index
          ? `sends /${handle} plus ${Math.min(config.decoys, index.snapshot.profiles.length - 1 > 0 ? config.decoys : 0)} decoy names in one burst, so zcash.me cannot tell which you want in this lookup. it still sees your ip; repeat lookups of the same name can be correlated across sessions.`
          : 'sends the username and your ip to zcash.me. download the directory in settings to avoid per-name lookups.'}
      </p>
      {!proxyEnabled && (
        <p className='mt-1 flex items-start gap-1 text-label text-amber-400'>
          <span className='i-ph-warning mt-0.5 h-3 w-3 shrink-0' />
          your ip is exposed to zcash.me. decoys hide the name, not your ip - turn on the proxy in
          privacy settings to hide it.
        </p>
      )}
      {error && <p className='mt-1 text-label text-red-400'>{error}</p>}
    </div>
  );
}
