/**
 * bits shared across the per-network send forms (cosmos-send.tsx,
 * penumbra-send.tsx, ibc-send.tsx) that don't belong to any one of them.
 */

import type { AddressNetwork } from '../../../state/recent-addresses';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

/** stable empty list so memo/effect deps don't churn while balances load */
export const EMPTY_BALANCES: BalancesResponse[] = [];

/** contact save suggestion prompt */
export function SaveContactPrompt({
  onSave,
  onDismiss,
}: {
  address: string;
  network: AddressNetwork;
  onSave: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className='border border-zigner-gold/30 bg-zigner-gold/10 p-3'>
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <span className='i-ph-user h-4 w-4 text-zigner-gold' />
          <div>
            <p className='text-sm text-fg'>save to contacts?</p>
            <p className='text-xs text-fg-muted'>you've sent to this address before</p>
          </div>
        </div>
        <button onClick={onDismiss} className='text-fg-muted hover:text-fg-high transition-colors'>
          <span className='i-ph-x h-4 w-4' />
        </button>
      </div>
      <div className='mt-2 flex gap-2'>
        <button
          onClick={onSave}
          className='flex-1 bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-gold-foreground transition-colors hover:bg-zigner-gold-light'
        >
          save contact
        </button>
        <button
          onClick={onDismiss}
          className='flex-1 bg-elev-2 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-elev-1/80 hover:text-fg-high'
        >
          not now
        </button>
      </div>
    </div>
  );
}
