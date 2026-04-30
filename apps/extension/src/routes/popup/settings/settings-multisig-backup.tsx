/**
 * Batch FROST multisig backup. Single passphrase encrypts every
 * self-custody multisig share into one file. Airgap wallets are listed
 * but not included — those are exported from zigner.
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { selectMultisigWallets } from '../../../state/wallets';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { usePasswordGate } from '../../../hooks/password-gate';
import { BackupModal } from '../multisig/backup/backup-modal';
import { ImportModal } from '../multisig/backup/import-modal';
import { AirgapQrImportModal } from '../multisig/backup/airgap-qr-import-modal';
import {
  exportBatchBackup,
  exportSingleBackup,
} from '../multisig/backup/export-helpers';

export const SettingsMultisigBackup = () => {
  const allMs = useStore(selectMultisigWallets);
  const selfCustody = allMs.filter(w => w.multisig?.custody !== 'airgapSigner');
  const airgap = allMs.filter(w => w.multisig?.custody === 'airgapSigner');

  const [batchOpen, setBatchOpen] = useState(false);
  const [singleTarget, setSingleTarget] = useState<typeof allMs[number] | null>(null);
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
        title={`Export ${selfCustody.length} wallet${selfCustody.length === 1 ? '' : 's'}`}
        walletLabel={`${selfCustody.length} self-custody multisig wallet${selfCustody.length === 1 ? '' : 's'}`}
        batch
        onConfirm={async (passphrase) => {
          await exportBatchBackup(selfCustody, passphrase);
          showToast(`exported ${selfCustody.length} wallet${selfCustody.length === 1 ? '' : 's'}`);
        }}
        onClose={() => setBatchOpen(false)}
      />
      <BackupModal
        open={singleTarget !== null}
        title={singleTarget ? `Export "${singleTarget.label}"` : ''}
        walletLabel={singleTarget?.label ?? ''}
        onConfirm={async (passphrase) => {
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
        onImported={(s) => showToast(
          `restored ${s.imported} wallet${s.imported === 1 ? '' : 's'}` +
          (s.skipped ? ` (${s.skipped} already existed)` : ''),
        )}
      />
      <AirgapQrImportModal
        open={airgapQrOpen}
        onClose={() => setAirgapQrOpen(false)}
        onImported={(s) => showToast(
          `imported ${s.imported} airgap wallet${s.imported === 1 ? '' : 's'}` +
          (s.skipped ? ` (${s.skipped} already existed)` : ''),
        )}
      />

      <div className='flex flex-col gap-4'>
        {toast && (
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-2 text-xs text-green-400'>
            {toast}
          </div>
        )}

        {/* batch export */}
        <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
          <p className='text-sm font-medium'>Batch backup</p>
          <p className='mt-1 text-[11px] text-fg-muted'>
            One encrypted file containing every self-custody multisig
            wallet. Single passphrase. Restore on any zafu install.
          </p>
          {selfCustody.length === 0 ? (
            <p className='mt-3 text-xs text-fg-muted'>
              No self-custody multisig wallets to backup.
            </p>
          ) : (
            <button
              onClick={async () => {
                if (await requestAuth()) setBatchOpen(true);
              }}
              className='mt-3 w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-xs text-zigner-gold hover:bg-primary/10 transition-colors'
            >
              export all ({selfCustody.length} wallet{selfCustody.length === 1 ? '' : 's'})
            </button>
          )}
        </div>

        {/* per-wallet list */}
        {selfCustody.length > 0 && (
          <div>
            <p className='mb-2 text-[10px] uppercase tracking-wide text-fg-muted'>
              Or export individually
            </p>
            <div className='flex flex-col gap-1.5'>
              {selfCustody.map(w => (
                <div
                  key={w.id}
                  className='flex items-center justify-between rounded-lg border border-border-soft bg-elev-1 px-3 py-2'
                >
                  <div className='flex flex-col min-w-0'>
                    <span className='text-sm font-medium truncate'>{w.label}</span>
                    <span className='text-[10px] text-fg-muted'>
                      {w.multisig!.threshold}-of-{w.multisig!.maxSigners} · self-custody
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      if (await requestAuth()) setSingleTarget(w);
                    }}
                    className='rounded-md border border-border-soft px-2 py-1 text-[11px] text-fg-muted hover:text-zigner-gold hover:bg-elev-2 transition-colors'
                  >
                    export
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* airgap notice */}
        {airgap.length > 0 && (
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-[11px] text-fg-muted'>
              <span className='font-medium text-fg'>{airgap.length} airgap wallet
              {airgap.length === 1 ? '' : 's'}</span>{' '}
              not included — those shares live on zigner. Export each
              from the zigner FROST wallet list.
            </p>
            <ul className='mt-2 flex flex-col gap-0.5 text-[10px] text-fg-muted'>
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
          <p className='text-sm font-medium'>Restore</p>
          <p className='text-[11px] text-fg-muted'>
            Import an encrypted backup file (self-custody share material), or
            scan an airgap QR from a zigner to re-add airgap multisig wallets.
            Already-known wallets are skipped, not overwritten.
          </p>
          <button
            onClick={async () => {
              if (await requestAuth()) setRestoreOpen(true);
            }}
            className='w-full rounded-lg border border-border-soft py-2.5 text-xs hover:bg-elev-2 transition-colors'
          >
            restore from backup file
          </button>
          <button
            onClick={async () => {
              if (await requestAuth()) setAirgapQrOpen(true);
            }}
            className='w-full rounded-lg border border-border-soft py-2.5 text-xs hover:bg-elev-2 transition-colors'
          >
            import airgap QR from zigner
          </button>
        </div>
      </div>
    </SettingsScreen>
  );
};
