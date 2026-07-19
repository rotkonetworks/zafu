/**
 * Batch FROST multisig backup. Single passphrase encrypts every
 * self-custody multisig share into one file. Airgap wallets are listed
 * but not included — those are exported from zigner.
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { selectMultisigWallets } from '../../../state/wallets';
import { Button } from '@repo/ui/components/ui/button';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { usePasswordGate } from '../../../hooks/password-gate';
import { BackupModal } from '../multisig/backup/backup-modal';
import { ImportModal } from '../multisig/backup/import-modal';
import { AirgapQrImportModal } from '../multisig/backup/airgap-qr-import-modal';
import { exportBatchBackup, exportSingleBackup } from '../multisig/backup/export-helpers';

export const SettingsMultisigBackup = () => {
  const allMs = useStore(selectMultisigWallets);
  const selfCustody = allMs.filter(w => w.multisig?.custody !== 'airgapSigner');
  const airgap = allMs.filter(w => w.multisig?.custody === 'airgapSigner');

  const [batchOpen, setBatchOpen] = useState(false);
  const [singleTarget, setSingleTarget] = useState<(typeof allMs)[number] | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [airgapQrOpen, setAirgapQrOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { requestAuth, PasswordModal } = usePasswordGate();
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <SettingsScreen title='multisig backup' backPath={PopupPath.SETTINGS}>
      {PasswordModal}
      <BackupModal
        open={batchOpen}
        title={`export ${selfCustody.length} wallet${selfCustody.length === 1 ? '' : 's'}`}
        walletLabel={`${selfCustody.length} self-custody multisig wallet${selfCustody.length === 1 ? '' : 's'}`}
        batch
        onConfirm={async passphrase => {
          await exportBatchBackup(selfCustody, passphrase);
          showToast(`exported ${selfCustody.length} wallet${selfCustody.length === 1 ? '' : 's'}`);
        }}
        onClose={() => setBatchOpen(false)}
      />
      <BackupModal
        open={singleTarget !== null}
        title={singleTarget ? `export "${singleTarget.label}"` : ''}
        walletLabel={singleTarget?.label ?? ''}
        onConfirm={async passphrase => {
          if (singleTarget) {
            await exportSingleBackup(singleTarget, passphrase);
            showToast(`exported "${singleTarget.label}"`);
          }
        }}
        onClose={() => setSingleTarget(null)}
      />
      <ImportModal
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onImported={s =>
          showToast(
            `restored ${s.imported} wallet${s.imported === 1 ? '' : 's'}` +
              (s.skipped ? ` (${s.skipped} already existed)` : ''),
          )
        }
      />
      <AirgapQrImportModal
        open={airgapQrOpen}
        onClose={() => setAirgapQrOpen(false)}
        onImported={s =>
          showToast(
            `imported ${s.imported} airgap wallet${s.imported === 1 ? '' : 's'}` +
              (s.skipped ? ` (${s.skipped} already existed)` : ''),
          )
        }
      />

      <div className='flex flex-col gap-4'>
        {toast && (
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-2 text-xs text-green-400'>
            {toast}
          </div>
        )}

        {/* batch export */}
        <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
          <p className='text-sm font-medium'>batch backup</p>
          <p className='mt-1 text-body text-fg-muted'>
            one encrypted file, one passphrase - restore on any zafu install.
          </p>
          {selfCustody.length === 0 ? (
            <p className='mt-3 text-xs text-fg-muted'>
              no self-custody multisig wallets to back up.
            </p>
          ) : (
            <Button
              variant='default'
              size='md'
              className='mt-3 w-full gap-1.5 text-xs'
              onClick={async () => {
                if (await requestAuth()) {
                  setBatchOpen(true);
                }
              }}
            >
              <span className='i-lucide-archive h-3.5 w-3.5' />
              export all ({selfCustody.length} wallet{selfCustody.length === 1 ? '' : 's'})
            </Button>
          )}
        </div>

        {/* per-wallet list */}
        {selfCustody.length > 0 && (
          <div>
            <p className='mb-2 text-label uppercase tracking-wide text-fg-muted'>
              individual exports
            </p>
            <div className='flex flex-col gap-1.5'>
              {selfCustody.map(w => (
                <div
                  key={w.id}
                  className='flex items-center justify-between rounded-lg border border-border-soft bg-elev-1 px-3 py-2'
                >
                  <div className='flex flex-col min-w-0'>
                    <span className='text-sm font-medium truncate'>{w.label}</span>
                    <span className='text-label text-fg-muted'>
                      {w.multisig!.threshold}-of-{w.multisig!.maxSigners} · self-custody
                    </span>
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={async () => {
                      if (await requestAuth()) {
                        setSingleTarget(w);
                      }
                    }}
                  >
                    export
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* airgap notice */}
        {airgap.length > 0 && (
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-body text-fg-muted'>
              <span className='font-medium text-fg'>
                {airgap.length} airgap wallet
                {airgap.length === 1 ? '' : 's'}
              </span>{' '}
              not included - export each from the zigner FROST wallet list.
            </p>
            <ul className='mt-2 flex flex-col gap-0.5 text-label text-fg-muted'>
              {airgap.map(w => (
                <li key={w.id} className='font-mono'>
                  · {w.label} ({w.multisig!.threshold}-of-{w.multisig!.maxSigners})
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* restore */}
        <div className='border-t border-border-soft pt-4 flex flex-col gap-2'>
          <p className='text-sm font-medium'>restore</p>
          <p className='text-body text-fg-muted'>
            import a backup file or scan an airgap QR - known wallets are skipped, not overwritten.
          </p>
          <div className='flex gap-2'>
            <Button
              variant='secondary'
              size='md'
              className='flex-1 gap-1.5 text-xs'
              onClick={async () => {
                if (await requestAuth()) {
                  setRestoreOpen(true);
                }
              }}
            >
              <span className='i-lucide-file-up h-3.5 w-3.5' />
              from backup file
            </Button>
            <Button
              variant='secondary'
              size='md'
              className='flex-1 gap-1.5 text-xs'
              onClick={async () => {
                if (await requestAuth()) {
                  setAirgapQrOpen(true);
                }
              }}
            >
              <span className='i-lucide-qr-code h-3.5 w-3.5' />
              from zigner QR
            </Button>
          </div>
        </div>
      </div>
    </SettingsScreen>
  );
};
