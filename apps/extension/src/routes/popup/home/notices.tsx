import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Button } from '@repo/ui/components/ui/button';

/** dismissible backup reminder - gone forever once confirmed */
export const BackupNudge = ({
  onBackUp,
  onDismiss,
}: {
  onBackUp: () => void;
  onDismiss: () => void;
}) => (
  <StatusSlot tone='warn' icon='i-ph-warning' action={{ label: 'back up', onClick: onBackUp }}>
    <span className='flex items-center gap-2'>
      recovery phrase not backed up
      <button
        type='button'
        onClick={onDismiss}
        title='I already backed it up'
        className='text-fg-dim transition-colors hover:text-fg-high'
      >
        <span className='i-ph-x size-3' />
      </button>
    </span>
  </StatusSlot>
);

/**
 * Empty-balance hint shown to a new user whose wallet is synced but holds
 * zero ZEC. Two concrete next steps so the wallet doesn't feel like a dead
 * end: receive (here's your address) and exchanges (where to buy). A swap
 * path was removed - the swap button sits directly above this panel, and
 * Penumbra DEX has no ZEC liquidity yet so the old copy over-promised.
 *
 * Dismissable in the sense that any inbound ZEC makes the panel disappear
 * naturally - there is no manual hide because the panel is informational
 * and we want to nudge action.
 */
export const GetZecHint = ({ onReceive }: { onReceive: () => void }) => (
  <div className='flex flex-col gap-2'>
    <Button variant='primary' onClick={onReceive} className='w-full'>
      <span className='i-ph-arrow-line-down size-4' />
      receive zec
    </Button>
    <RowGroup>
      <Row
        type='screen'
        icon='i-ph-shopping-bag'
        label='buy at an exchange'
        description='z.cash list of supported exchanges'
        onPress={() => window.open('https://z.cash/get-started/', '_blank', 'noopener,noreferrer')}
      />
    </RowGroup>
  </div>
);
