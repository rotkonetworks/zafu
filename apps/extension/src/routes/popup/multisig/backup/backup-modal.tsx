/**
 * Passphrase entry modal for FROST multisig backup export.
 * Always starts with empty fields — never caches the backup passphrase.
 */

import { useState, useEffect } from 'react';

interface Props {
  open: boolean;
  /** title shown in the modal header (e.g. "Export treasury" / "Export 3 wallets") */
  title: string;
  /** label that ends up in the envelope's plaintext + filename */
  walletLabel: string;
  /** is this exporting one wallet (false) or many (true)? */
  batch?: boolean;
  /** receives the passphrase the user typed; should perform the export + download. */
  onConfirm: (passphrase: string) => Promise<void>;
  onClose: () => void;
}

export const BackupModal = ({ open, title, walletLabel, batch = false, onConfirm, onClose }: Props) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // reset every time the modal opens — never carry passphrase across sessions
  useEffect(() => {
    if (open) {
      setPassphrase('');
      setConfirm('');
      setError(null);
      setWorking(false);
    }
  }, [open]);

  if (!open) return null;

  const canConfirm = passphrase.length >= 8 && passphrase === confirm && !working;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setError(null);
    setWorking(true);
    try {
      await onConfirm(passphrase);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'export failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg border border-border-soft bg-elev-1 p-4">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="mt-1 text-[10px] text-fg-muted">
          {batch ? `Exporting ${walletLabel}.` : `Exporting "${walletLabel}".`}
        </p>

        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[10px] text-amber-300">
          <span className="i-lucide-alert-triangle mr-1 inline-block size-3 align-text-bottom" />
          This file contains the FROST share. Anyone with the file AND the
          passphrase can sign as this signer. The passphrase cannot be reset
          — losing it means the backup is unusable.
        </div>

        <label className="mt-3 block text-xs text-fg-muted">
          backup passphrase
          <input
            type="password"
            autoFocus
            autoComplete="new-password"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none"
            placeholder="at least 8 characters"
          />
        </label>

        <label className="mt-2 block text-xs text-fg-muted">
          confirm passphrase
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none"
          />
        </label>

        {confirm.length > 0 && passphrase !== confirm && (
          <p className="mt-1 text-[10px] text-red-400">passphrases don't match</p>
        )}
        {passphrase.length > 0 && passphrase.length < 8 && (
          <p className="mt-1 text-[10px] text-amber-400">at least 8 characters</p>
        )}
        {error && (
          <p className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-400">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            disabled={working}
            onClick={onClose}
            className="flex-1 rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-2 transition-colors disabled:opacity-50"
          >
            cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
            className="flex-1 rounded-lg border border-primary/40 bg-primary/5 py-2 text-xs text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {working ? 'encrypting...' : 'export'}
          </button>
        </div>
      </div>
    </div>
  );
};
