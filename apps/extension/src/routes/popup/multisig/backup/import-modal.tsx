/**
 * Import FROST backup: file picker → envelope inspection (label/pkg shown
 * before passphrase) → passphrase → restore.
 */

import { useEffect, useState } from 'react';
import {
  importBackup,
  readEnvelopeFromFile,
  type ImportSummary,
} from './import-helpers';
import type { FrostBackupEnvelope } from '../../../../state/keyring/multisig-backup';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}

export const ImportModal = ({ open, onClose, onImported }: Props) => {
  const [envelope, setEnvelope] = useState<FrostBackupEnvelope | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setEnvelope(null);
      setPassphrase('');
      setError(null);
      setWorking(false);
    }
  }, [open]);

  if (!open) return null;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setWorking(true);
    try {
      const env = await readEnvelopeFromFile(file);
      setEnvelope(env);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to read backup');
    } finally {
      setWorking(false);
    }
  };

  const handleImport = async () => {
    if (!envelope || passphrase.length === 0 || working) return;
    setError(null);
    setWorking(true);
    try {
      const summary = await importBackup(envelope, passphrase);
      onImported(summary);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed');
    } finally {
      setWorking(false);
    }
  };

  const isBatch = envelope?.type === 'frost-share-batch-backup';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg border border-border-soft bg-elev-1 p-4">
        <h2 className="text-base font-medium">Restore multisig backup</h2>

        {!envelope ? (
          <>
            <p className="mt-1 text-[10px] text-fg-muted">
              Select an encrypted backup file (.json) you created earlier.
            </p>
            <label className="mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border-soft bg-elev-2 px-4 py-6 hover:bg-elev-3 transition-colors">
              <span className="i-lucide-file-up size-6 text-fg-muted" />
              <span className="text-xs text-fg-muted">tap to choose backup file</span>
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={e => void handleFile(e.target.files?.[0])}
              />
            </label>
          </>
        ) : (
          <>
            <div className="mt-3 rounded-lg border border-border-soft bg-elev-2 p-3 text-[11px]">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">backup file</p>
              <p className="mt-0.5 font-medium">{envelope.label}</p>
              {isBatch ? (
                <p className="mt-0.5 text-[10px] text-fg-muted">
                  contains {envelope.shareCount ?? '?'} multisig wallet
                  {envelope.shareCount === 1 ? '' : 's'}
                </p>
              ) : envelope.publicKeyPackage ? (
                <p className="mt-0.5 break-all font-mono text-[9px] text-fg-muted">
                  pkg: …{envelope.publicKeyPackage.slice(-16)}
                </p>
              ) : null}
              <p className="mt-1 text-[10px] text-fg-muted">
                exported: {new Date(envelope.exportedAt).toLocaleString()}
              </p>
            </div>

            <label className="mt-3 block text-xs text-fg-muted">
              backup passphrase
              <input
                type="password"
                autoFocus
                autoComplete="off"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none"
              />
            </label>
          </>
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
          {envelope && (
            <button
              disabled={passphrase.length === 0 || working}
              onClick={() => void handleImport()}
              className="flex-1 rounded-lg border border-primary/40 bg-primary/5 py-2 text-xs text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {working ? 'restoring...' : 'restore'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
