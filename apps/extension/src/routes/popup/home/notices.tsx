import { StatusSlot } from '@repo/ui/components/ui/status-slot';

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
