import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectZcashWallets, walletsSelector } from '../../../state/wallets';
import { keyRingSelector } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { usePopupNav } from '../../../utils/navigate';
import { usePasswordGate } from '../../../hooks/password-gate';
import { BackupModal } from '../multisig/backup/backup-modal';
import { exportSingleBackup } from '../multisig/backup/export-helpers';

export const SettingsMultisig = () => {
  const [params] = useSearchParams();
  const walletId = params.get('id');
  const navigate = usePopupNav();

  const zcashWallets = useStore(selectZcashWallets);
  const { updateMultisigWallet } = useStore(walletsSelector);
  const { deleteKeyRing, renameKeyRing } = useStore(keyRingSelector);

  const wallet = zcashWallets.find(w => w.id === walletId);

  const [label, setLabel] = useState(wallet?.label ?? '');
  const [relayUrl, setRelayUrl] = useState(wallet?.multisig?.relayUrl ?? '');
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const { requestAuth, PasswordModal } = usePasswordGate();

  if (!wallet?.multisig) {
    return (
      <SettingsScreen title='multisig' backPath={PopupPath.SETTINGS_WALLETS}>
        <p className='text-xs text-fg-muted'>wallet not found</p>
      </SettingsScreen>
    );
  }

  const ms = wallet.multisig;

  const handleSave = async () => {
    const trimmed = label.trim() || wallet.label;
    await updateMultisigWallet(wallet.id, {
      label: trimmed,
      relayUrl: relayUrl.trim(),
    });
    // also rename the parent keyring vault so the wallets settings page
    // shows the same name (vault.name and zcashWallet.label otherwise drift).
    if (wallet.vaultId) {
      await renameKeyRing(wallet.vaultId, trimmed).catch(() => {});
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDelete = async () => {
    if (!wallet.vaultId) {
      return;
    }
    try {
      // app-managed (hidden) tables are refused here by the keyring guard — they can only be
      // removed from the multisig manager after backup. Surface that instead of failing silently.
      await deleteKeyRing(wallet.vaultId);
      navigate(PopupPath.SETTINGS_WALLETS);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : 'could not delete this wallet');
    }
  };

  return (
    <SettingsScreen title='multisig settings' backPath={PopupPath.SETTINGS_WALLETS}>
      {PasswordModal}
      <BackupModal
        open={backupOpen}
        title={`export "${wallet.label}"`}
        walletLabel={wallet.label}
        onConfirm={passphrase => exportSingleBackup(wallet, passphrase)}
        onClose={() => setBackupOpen(false)}
      />
      <div className='flex flex-col gap-4'>
        {/* info */}
        <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
          <div className='flex items-center gap-2'>
            <span className='rounded-md bg-primary/10 px-2 py-0.5 text-label font-medium text-zigner-gold'>
              {ms.threshold}/{ms.maxSigners}
            </span>
          </div>
          <p className='mt-2 text-label text-fg-muted'>address</p>
          <p className='break-all font-mono text-xs'>{wallet.address}</p>
        </div>

        {/* editable fields */}
        <label className='text-xs text-fg-muted'>
          label
          <input
            className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </label>

        <label className='text-xs text-fg-muted'>
          relay url
          <input
            className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
            value={relayUrl}
            onChange={e => setRelayUrl(e.target.value)}
            placeholder='wss://zrelay.rotko.net'
          />
        </label>

        <button
          onClick={() => void handleSave()}
          className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors'
        >
          save
        </button>

        {saved && (
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-2 text-xs text-green-400 text-center'>
            saved
          </div>
        )}

        {/* backup */}
        <div className='border-t border-border-soft pt-4'>
          {ms.custody === 'airgapSigner' ? (
            <div className='rounded-lg border border-border-soft bg-elev-1 p-3 text-body text-fg-muted'>
              <p className='font-medium text-fg'>backup</p>
              <p className='mt-1'>
                this share lives on your zigner - export it there under multisig wallets.
              </p>
            </div>
          ) : (
            <button
              onClick={async () => {
                const ok = await requestAuth();
                if (ok) {
                  setBackupOpen(true);
                }
              }}
              className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-xs text-zigner-gold hover:bg-primary/10 transition-colors'
            >
              export backup
            </button>
          )}
        </div>

        {/* delete */}
        <div className='border-t border-border-soft pt-4'>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className='w-full rounded-lg border border-red-500/25 bg-red-500/5 py-2.5 text-xs text-red-400 hover:bg-red-500/15 transition-colors'
            >
              delete wallet
            </button>
          ) : (
            <div className='flex flex-col gap-2'>
              <p className='text-xs text-red-400'>
                permanently delete this multisig wallet? this cannot be undone - you would need to
                run DKG again.
              </p>
              {delError && (
                <p className='rounded-md border border-red-500/40 bg-red-500/5 p-2 text-body text-red-300'>
                  {delError}
                </p>
              )}
              <div className='flex gap-2'>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className='flex-1 rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
                >
                  cancel
                </button>
                <button
                  onClick={() => void handleDelete()}
                  className='flex-1 rounded-lg border border-red-500/25 bg-red-500/15 py-2 text-xs text-red-400 hover:bg-red-500/25 transition-colors'
                >
                  confirm delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsScreen>
  );
};
