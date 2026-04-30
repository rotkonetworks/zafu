/**
 * Scan a zigner-emitted "zafu-airgap-import" QR and re-add the airgap
 * multisig wallets it carries. The QR is unencrypted (public-only metadata,
 * no secret material) so this flow has no passphrase step — just scan,
 * review, confirm, import.
 */

import { useEffect, useState } from 'react';
import { AnimatedQrScanner } from '../../../../shared/components/animated-qr-scanner';
import { useStore } from '../../../../state';
import { selectMultisigWallets } from '../../../../state/wallets';
import type { ImportSummary } from './import-helpers';

interface AirgapWallet {
  label: string;
  /** zigner-side device-local wallet_id, deterministic from publicKeyPackage.
   *  Optional for back-compat with older zigner builds that didn't include it. */
  walletId?: string;
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  mainnet: boolean;
  orchardFvk: string;
  address: string;
  relayUrl: string;
}

interface Payload {
  frost?: string;
  version?: number;
  wallets?: AirgapWallet[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}

export const AirgapQrImportModal = ({ open, onClose, onImported }: Props) => {
  const [payload, setPayload] = useState<AirgapWallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setPayload(null);
      setError(null);
      setWorking(false);
    }
  }, [open]);

  if (!open) return null;

  const handleScan = (data: Uint8Array) => {
    try {
      const text = new TextDecoder().decode(data);
      const parsed = JSON.parse(text) as Payload;
      if (parsed.frost !== 'airgap-import' || parsed.version !== 1) {
        throw new Error('not a zigner airgap-import QR');
      }
      const wallets = parsed.wallets;
      if (!Array.isArray(wallets) || wallets.length === 0) {
        throw new Error('no wallets in QR payload');
      }
      // basic shape check on every entry — fail fast on partial payloads
      for (const w of wallets) {
        if (!w.publicKeyPackage || !w.orchardFvk || !w.address || !w.relayUrl) {
          throw new Error('payload missing required metadata fields');
        }
      }
      setPayload(wallets);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to parse QR payload');
    }
  };

  const handleConfirm = async () => {
    if (!payload) return;
    setError(null);
    setWorking(true);
    try {
      const existing = selectMultisigWallets(useStore.getState());
      const existingKeys = new Set(existing.map(w => w.multisig?.publicKeyPackage).filter(Boolean));
      let imported = 0;
      let skipped = 0;
      for (const w of payload) {
        if (existingKeys.has(w.publicKeyPackage)) { skipped++; continue; }
        await useStore.getState().keyRing.newFrostMultisigKey({
          label: w.label,
          address: w.address,
          orchardFvk: w.orchardFvk,
          publicKeyPackage: w.publicKeyPackage,
          threshold: w.threshold,
          maxSigners: w.maxSigners,
          relayUrl: w.relayUrl,
          custody: 'airgapSigner',
          ...(w.walletId ? { zignerWalletId: w.walletId } : {}),
        });
        imported++;
      }
      onImported({ imported, skipped, total: payload.length });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg border border-border-soft bg-elev-1 p-4">
        <h2 className="text-base font-medium">Import airgap multisig from zigner</h2>

        {!payload ? (
          <>
            <p className="mt-1 text-[10px] text-fg-muted">
              Scan the animated QR your zigner shows. Public metadata only —
              no secrets cross over.
            </p>
            <div className="mt-3">
              <AnimatedQrScanner
                inline
                title="scan zigner airgap-import QR"
                onComplete={handleScan}
                onClose={onClose}
              />
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-[10px] text-fg-muted">
              {payload.length} wallet{payload.length === 1 ? '' : 's'} ready to import as airgap multisig.
            </p>
            <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border-soft bg-elev-2 p-2 flex flex-col gap-1.5">
              {payload.map((w, i) => (
                <div key={i} className="rounded-md bg-elev-1 p-2 text-[11px]">
                  <p className="font-medium">{w.label}</p>
                  <p className="text-[10px] text-fg-muted">{w.threshold}-of-{w.maxSigners} · {w.mainnet ? 'mainnet' : 'testnet'}</p>
                  <p className="text-[10px] font-mono text-fg-muted truncate">{w.address.slice(0, 16)}…{w.address.slice(-8)}</p>
                </div>
              ))}
            </div>
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
          {payload && (
            <button
              disabled={working}
              onClick={() => void handleConfirm()}
              className="flex-1 rounded-lg border border-primary/40 bg-primary/5 py-2 text-xs text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {working ? 'importing...' : `import ${payload.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
