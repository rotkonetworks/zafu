import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { PopupPath } from '../paths';

/** dismissible backup reminder - dismissing hides it for this visit without
 *  marking the phrase backed up */
export const BackupNudge = ({
  onBackUp,
  onDismiss,
}: {
  onBackUp: () => void;
  onDismiss: () => void;
}) => (
  <StatusSlot tone='warn' icon='i-ph-warning' action={{ label: 'back up', onClick: onBackUp }}>
    <span className='flex items-center gap-2'>
      your recovery phrase isn&apos;t backed up yet
      <button
        type='button'
        onClick={onDismiss}
        title='not now'
        aria-label='not now'
        className='text-fg-dim transition-colors hover:text-fg-high'
      >
        <span className='i-ph-x size-3' />
      </button>
    </span>
  </StatusSlot>
);

/** shown on home and receive until the phrase is backed up; dismissing hides
 *  only this screen for now and never marks seedPhraseBackedUp */
export const useBackupNudge = () => {
  const key = useStore(selectEffectiveKeyInfo);
  const navigate = useNavigate();
  const [needed, setNeeded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    if (key?.type !== 'mnemonic') {
      setNeeded(false);
      return;
    }
    let cancelled = false;
    void localExtStorage.get('seedPhraseBackedUp').then(done => {
      if (!cancelled) {
        setNeeded(done !== true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key?.type, key?.id]);

  if (!needed || dismissed) {
    return null;
  }
  return (
    <BackupNudge
      onBackUp={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
      onDismiss={() => setDismissed(true)}
    />
  );
};
