import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectZcashWallets, walletsSelector } from '../../../state/wallets';
import { deleteWalletInWorker } from '../../../state/keyring/network-worker';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { usePopupNav } from '../../../utils/navigate';

export const SettingsMultisig = () => {
  const [params] = useSearchParams();
  const walletId = params.get('id');
  const navigate = usePopupNav();

  const zcashWallets = useStore(selectZcashWallets);
  const { updateMultisigWallet, removeZcashWallet } = useStore(walletsSelector);

  const wallet = zcashWallets.find(w => w.id === walletId);
  const walletIndex = zcashWallets.findIndex(w => w.id === walletId);

  const [label, setLabel] = useState(wallet?.label ?? '');
  const [relayUrl, setRelayUrl] = useState(wallet?.multisig?.relayUrl ?? '');
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!wallet?.multisig) {
    return (
      <SettingsScreen title='multisig' backPath={PopupPath.SETTINGS_WALLETS}>
        <p className='text-xs text-muted-foreground'>wallet not found</p>
      </SettingsScreen>
    );
  }

  const ms = wallet.multisig;

  const handleSave = async () => {
    await updateMultisigWallet(wallet.id, {
      label: label.trim() || wallet.label,
      relayUrl: relayUrl.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDelete = async () => {
    // clean up IndexedDB note data before removing wallet record
    try {
      await deleteWalletInWorker('zcash', wallet.id);
    } catch {
      // worker may not be running — continue with removal
    }
    await removeZcashWallet(walletIndex);
    navigate(PopupPath.SETTINGS_WALLETS);
  };

  return (
    <SettingsScreen title='multisig settings' backPath={PopupPath.SETTINGS_WALLETS}>
      <div className='flex flex-col gap-4'>
        {/* info */}
        <div className='rounded-lg border border-border/40 bg-card p-3'>
          <div className='flex items-center gap-2'>
            <span className='rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary'>
              {ms.threshold}/{ms.maxSigners}
            </span>
          </div>
          <p className='mt-2 text-[10px] text-muted-foreground'>address</p>
          <p className='break-all font-mono text-xs'>{wallet.address}</p>
        </div>

        {/* editable fields */}
        <label className='text-xs text-muted-foreground'>
          label
          <input
            className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </label>

        <label className='text-xs text-muted-foreground'>
          relay url
          <input
            className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
            value={relayUrl}
            onChange={e => setRelayUrl(e.target.value)}
            placeholder='https://zidecar.rotko.net'
          />
        </label>

        <button
          onClick={() => void handleSave()}
          className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-primary hover:bg-primary/10 transition-colors'
        >
          save
        </button>

        {saved && (
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-2 text-xs text-green-400 text-center'>
            saved
          </div>
        )}

        {/* delete */}
        <div className='border-t border-border/40 pt-4'>
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
                permanently delete this multisig wallet? this cannot be undone — you would need to run DKG again.
              </p>
              <div className='flex gap-2'>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className='flex-1 rounded-lg border border-border/40 py-2 text-xs hover:bg-muted/50 transition-colors'
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
