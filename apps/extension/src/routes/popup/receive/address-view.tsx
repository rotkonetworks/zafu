/**
 * Board Receive: the code, what kind of address it is, the address with its
 * rotate button, and the actions pinned at the bottom. Every network's
 * receive (zcash, penumbra, its transparent chains) is this view.
 */

import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { QrCode } from '../../../components/qr-code';

export function AddressView({
  address,
  loading,
  retired,
  label,
  hint,
  tone = 'plain',
  onRotate,
  notice,
  children,
}: {
  address: string;
  loading: boolean;
  /** on screen but already handed out: dimmed until its replacement lands */
  retired?: boolean;
  label: string;
  hint?: string;
  /** a public address reads in the seal's red */
  tone?: 'plain' | 'public';
  onRotate?: () => void;
  /** one line under the code, e.g. why there is no address */
  notice?: ReactNode;
  /** the footer actions */
  children: ReactNode;
}) {
  const pub = tone === 'public';
  return (
    <div className='flex flex-1 flex-col items-center gap-4'>
      <div
        className={cn(
          'border border-surface-border-soft transition-opacity duration-150',
          retired && 'opacity-30',
        )}
      >
        {loading ? (
          <div className='size-48 animate-pulse bg-surface-elev-2/40' />
        ) : address ? (
          <QrCode value={address} size={192} label='address QR' />
        ) : (
          <div className='flex size-48 items-center justify-center'>
            <span className='text-label text-fg-dim lowercase'>no wallet</span>
          </div>
        )}
      </div>

      {notice && <p className='w-full text-label text-hanko-light lowercase'>{notice}</p>}

      <div className='w-full'>
        <div className='mb-1.5 flex items-center justify-between text-label lowercase'>
          <span className={pub ? 'text-hanko-light' : 'text-fg-muted'}>{label}</span>
          {hint && <span className='text-fg-muted'>{hint}</span>}
        </div>
        <div className='flex gap-1.5'>
          <div
            className={cn(
              'flex h-14 min-w-0 flex-1 items-center border p-3',
              pub ? 'border-hanko/35 bg-hanko/8' : 'border-surface-border-soft bg-surface-elev-2',
            )}
          >
            <code
              title={address || undefined}
              className={cn(
                'w-full truncate text-label transition-opacity duration-150',
                pub ? 'text-hanko-light' : 'text-fg-high',
                retired && 'opacity-30',
              )}
            >
              {loading ? 'generating...' : address || 'no wallet selected'}
            </code>
          </div>
          {onRotate && (
            <button
              onClick={onRotate}
              disabled={retired || loading}
              className='grid size-14 shrink-0 place-items-center border border-surface-border-soft bg-surface-elev-1 text-fg-muted transition-colors hover:text-fg-high disabled:cursor-not-allowed disabled:opacity-50'
              title='new address'
              aria-label='new address'
            >
              <span className='i-ph-arrows-clockwise size-4.5' />
            </button>
          )}
        </div>
      </div>

      <div className='-mx-4 mt-auto flex gap-2 self-stretch border-t border-surface-border-soft px-4 pt-4'>
        {children}
      </div>
    </div>
  );
}
