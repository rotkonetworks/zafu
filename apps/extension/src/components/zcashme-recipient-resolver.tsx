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

/** the PayName card: who the name points at, and whether it proved it */
function ProfileCard({ profile, onPick }: { profile: ZcashMeProfile; onPick: () => void }) {
  const name = zcashMeLabel(profile) ?? zcashMeUsername(profile);
  const a = profile.address;
  const links = profile.links.map(l => l.platform.toLowerCase()).join(' and ');
  return (
    <button
      type='button'
      onClick={onPick}
      className='flex min-h-[62px] w-full items-center gap-3 border border-border-hard bg-elev-1 px-3 py-2.5 text-left transition-colors hover:bg-elev-2'
    >
      <span className='grid size-[34px] shrink-0 place-items-center bg-elev-2 text-sm text-fg-high'>
        {Array.from(name)[0]}
      </span>
      <span className='flex min-w-0 flex-col gap-0.5'>
        <span className='truncate text-[13px] text-fg-high'>{name} on zcash.me</span>
        <span
          className={cn(
            'truncate text-[11px]',
            profile.addressVerified ? 'text-green' : 'text-warn',
          )}
        >
          {profile.addressVerified
            ? `verified ${links || 'address'} · ${a.slice(0, 6)}…${a.slice(-5)}`
            : 'not proven to be theirs · please confirm with them first'}
        </span>
      </span>
    </button>
  );
}

export function ZcashMeRecipientResolver({ input, onResolve }: Props) {
  const handle = parseZcashMeHandle(input);
  const { config, index } = useZcashMe();
  const proxyEnabled = useStore(privacySettingsSelector).proxy.enabled;
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<{
    handle: string;
    profile: ZcashMeProfile;
    decoys: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // set when cover is on but no decoys are available, gating an uncovered lookup
  const [needBareConfirm, setNeedBareConfirm] = useState(false);

  // a new handle invalidates the previous live answer
  useEffect(() => {
    setLive(null);
    setError(null);
    setNeedBareConfirm(false);
  }, [handle]);

  if (!handle || !config) {
    return null;
  }

  const box = 'border border-border-soft bg-elev-1 p-2';

  if (config.mode === 'off') {
    return <ZcashMeOptIn reason={`pay /${handle}`} respectDismissal={false} />;
  }

  const local = index?.byName.get(handle.toLowerCase());
  const profile = local ?? (live?.handle === handle ? live.profile : undefined);

  if (profile) {
    const decoys = live?.profile === profile ? live.decoys : 0;
    return (
      <>
        <ProfileCard profile={profile} onPick={() => onResolve(profile)} />
        {decoys > 0 && (
          <span className='text-[11px] text-fg-dim'>
            looked up with {decoys} decoy names · zcash.me can't tell which you wanted
          </span>
        )}
      </>
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
  const lookup = async (forceBare = false) => {
    setError(null);
    const coverExpected = config.decoys > 0;
    // draw real decoys from the snapshot when cover is enabled and a snapshot
    // is loaded
    const decoyNames = coverExpected && index ? pickDecoys(index, handle, config.decoys) : [];
    // cover was asked for but none can be drawn (no snapshot, or one too small
    // for even a single decoy). Do NOT silently send the bare name - that would
    // hand zcash.me exactly the name the user turned cover on to hide. Make the
    // user opt into the uncovered lookup instead.
    if (coverExpected && decoyNames.length === 0 && !forceBare) {
      setNeedBareConfirm(true);
      return;
    }
    setNeedBareConfirm(false);
    setPending(true);
    const res =
      decoyNames.length > 0
        ? await lookupZcashMeWithDecoys(handle, decoyNames, { spacingMs: 120 })
        : await lookupZcashMe(handle);
    setPending(false);
    if (res.ok) {
      setLive({ handle, profile: res.profile, decoys: decoyNames.length });
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
        zcash.me sees {proxyEnabled ? '' : 'your ip and '}/{handle}
        {config.decoys > 0 && (index?.snapshot.profiles.length ?? 0) > 1 && ' among decoys'}
      </p>
      {needBareConfirm && (
        <button
          type='button'
          disabled={pending}
          onClick={() => void lookup(true)}
          className='mt-1 text-left text-label text-warn hover:underline disabled:opacity-50'
        >
          no directory to draw decoys from · look up /{handle} without cover
        </button>
      )}
      {error && <p className='mt-1 text-label text-red-400'>{error}</p>}
    </div>
  );
}
