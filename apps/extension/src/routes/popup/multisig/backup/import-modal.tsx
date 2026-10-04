/**
 * Import FROST backup: file picker → envelope inspection (label/pkg shown
 * before passphrase) → passphrase → restore.
 */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { importBackup, readEnvelopeFromFile, type ImportSummary } from './import-helpers';
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

  if (!open) {
    return null;
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
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
    if (!envelope || passphrase.length === 0 || working) {
      return;
    }
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
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4'>
      <div className='w-full max-w-sm border border-border-soft bg-elev-1 p-4'>
        <h2 className='text-lg'>restore multisig backup</h2>

        {!envelope ? (
          <>
            <p className='mt-1 text-label text-fg-muted'>
              Select an encrypted backup file (.json) you created earlier.
            </p>
            <label className='mt-3 flex cursor-pointer flex-col items-center gap-2 border border-dashed border-border-soft bg-elev-2 px-4 py-6 hover:bg-elev-3 transition-colors'>
              <span className='i-ph-file-arrow-up size-6 text-fg-muted' />
              <span className='text-xs text-fg-muted'>tap to choose backup file</span>
              <input
                type='file'
                accept='application/json,.json'
                className='hidden'
                onChange={e => void handleFile(e.target.files?.[0])}
              />
            </label>
          </>
        ) : (
          <>
            <div className='mt-3 border border-border-soft bg-elev-2 p-3 text-body'>
              <p className='kicker'>backup file</p>
              <p className='mt-0.5'>{envelope.label}</p>
              {isBatch ? (
                <p className='mt-0.5 text-label text-fg-muted'>
                  contains {envelope.shareCount ?? '?'} multisig wallet
                  {envelope.shareCount === 1 ? '' : 's'}
                </p>
              ) : envelope.publicKeyPackage ? (
                <p className='mt-0.5 break-all font-mono text-label text-fg-muted'>
                  pkg: …{envelope.publicKeyPackage.slice(-16)}
                </p>
              ) : null}
              <p className='mt-1 text-label text-fg-muted'>
                exported: {new Date(envelope.exportedAt).toLocaleString()}
              </p>
            </div>

            <label className='mt-3 block text-xs text-fg-muted'>
              backup passphrase
              <input
                type='password'
                autoFocus
                autoComplete='off'
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                className='mt-1 w-full border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none'
              />
            </label>
          </>
        )}

        {error && (
          <p className='mt-2 border border-red-500/40 bg-red-500/5 p-2 text-body text-red-400'>
            {error}
          </p>
        )}

        <div className='mt-4 flex gap-2'>
          <Button
            variant='secondary'
            size='sm'
            disabled={working}
            onClick={onClose}
            className='flex-1'
          >
            cancel
          </Button>
          {envelope && (
            <Button
              variant='primary'
              size='sm'
              disabled={passphrase.length === 0 || working}
              onClick={() => void handleImport()}
              className='flex-1'
            >
              {working ? 'restoring...' : 'restore'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
