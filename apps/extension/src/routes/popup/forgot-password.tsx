/**
 * Forgot password (SetForgot.dc.html). zafu cannot recover a password: the
 * key is made from it and kept nowhere. The honest path is to erase this
 * computer's wallets and restore them from their phrases in onboarding, so
 * the screen says that, names what a phrase does not bring back, and erases
 * only after a deliberate second step.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { ScreenHeader } from '../../components/screen-header';
import { useStore } from '../../state';
import { walletKind } from '../../signing/wallet-kind';
import { useBackNav, usePopupNav } from '../../utils/navigate';
import { PagePath } from '../page/paths';
import { openOnboarding } from './welcome';
import { PopupPath } from './paths';

export const ForgotPassword = () => {
  const navigate = usePopupNav();
  const back = useBackNav(PopupPath.LOGIN);
  const eraseAll = useStore(s => s.keyRing.eraseAll);
  // vault names and kinds are plaintext metadata, readable while locked
  const unphrased = useStore(s =>
    s.keyRing.keyInfos
      .filter(k => walletKind(k) !== 'hot')
      .map(k => k.name)
      .join(', '),
  );
  const [step, setStep] = useState<'why' | 'erase'>('why');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [broke, setBroke] = useState(false);

  const erase = () => {
    setBusy(true);
    setBroke(false);
    void eraseAll()
      .then(() => openOnboarding(PagePath.IMPORT_SEED_PHRASE))
      .catch(() => {
        setBroke(true);
        setBusy(false);
      });
  };

  return (
    <div className='flex h-full min-h-[628px] flex-col bg-canvas'>
      <ScreenHeader
        title='restore with your phrase'
        backPath={PopupPath.LOGIN}
        onBack={step === 'erase' ? () => setStep('why') : undefined}
      />
      {step === 'why' ? (
        <div className='flex grow flex-col gap-3.5 px-4 pt-[18px]'>
          <p className='text-[13px]/[1.6] text-fg'>
            zafu cannot recover a password. your recovery phrase sets the wallet up again.
          </p>
          <StatusSlot
            tone='warn'
            icon='i-lucide-eye'
            action={{
              label: 'backups',
              onClick: () => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP),
            }}
          >
            <span className='text-fg'>
              multisig shares, viewing keys and paired devices are not in a phrase. they come back
              only from their own backups.
            </span>
            {unphrased && <span>on this computer: {unphrased}</span>}
          </StatusSlot>
        </div>
      ) : (
        <div className='flex grow flex-col gap-3.5 px-4 pt-[18px]'>
          <p className='text-[13px]/[1.6] text-fg'>
            every wallet is erased from this computer. what is on chain stays on chain.
          </p>
          <RowGroup>
            <Row
              type='toggle'
              label='i have my phrases and backups'
              checked={sure}
              onChange={setSure}
            />
          </RowGroup>
          <span className='h-[18px] text-label text-warning' aria-live='polite'>
            {broke ? 'something broke on our side, not yours. please try once more.' : ''}
          </span>
        </div>
      )}
      <div className='flex gap-2 border-t border-border-soft px-4 pb-4 pt-3'>
        {step === 'why' ? (
          <Button autoFocus className='w-full' onClick={() => setStep('erase')}>
            continue
          </Button>
        ) : (
          <>
            <Button variant='secondary' className='w-28' onClick={back}>
              not now
            </Button>
            <Button
              variant='danger'
              className='flex-1'
              disabled={!sure}
              loading={busy}
              onClick={erase}
            >
              erase and restore
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
