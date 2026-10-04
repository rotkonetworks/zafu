/** "cash": the first row where zec can be sold for money, picking usdc on base for a peer listing */

import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { PEER_SELL_URL } from '../config/ramps';

export const CashOutRow = ({ onPress }: { onPress: () => void }) => (
  <RowGroup>
    <Row
      type='screen'
      media={
        <span className='grid size-6 place-items-center border border-zigner-gold text-xs text-zigner-gold'>
          $
        </span>
      }
      label='cash'
      description='revolut, wise, zelle or monzo, through peer'
      onPress={onPress}
    />
  </RowGroup>
);

/** what happens after a cash-out swap, and the way onto peer */
export const PeerCashOutNote = () => (
  <p className='flex flex-col gap-1 text-[11px] text-fg-muted'>
    <span>
      the usdc lands at the base address above. list it on peer with your payment details, and
      buyers pay you in revolut, wise, zelle or monzo as they take it. use an address whose wallet
      you control. peer is an outside service.
    </span>
    <a
      href={PEER_SELL_URL}
      target='_blank'
      rel='noopener noreferrer'
      className='self-start text-zigner-gold hover:text-fg-high'
    >
      open peer
    </a>
  </p>
);
