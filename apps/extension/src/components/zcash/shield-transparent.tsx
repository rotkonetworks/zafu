/**
 * Transparent-pool shielding entry for the Zcash home surface.
 *
 * Extracted from routes/popup/home/index.tsx so home stays a calm layout
 * shell (Zashi restraint): instead of a red alarming box, transparent funds
 * fold into the single hero balance and this component renders one small
 * neutral row with a "shield" action. The full flow lives here:
 *
 *   - hot wallets: password-gated one-tap shield via the worker
 *   - watch-only (zigner): build unsigned tx -> show sign-request QR ->
 *     scan signature QR -> broadcast
 *
 * Self-contained: reads the active vault + keyring from the store and owns
 * its own password gate, so the parent only passes display/network inputs.
 */

import { useCallback, useState } from 'react';

import { useStore } from '../../state';
import { selectEffectiveKeyInfo, keyRingSelector } from '../../state/keyring';
import { usePasswordGate } from '../../hooks/password-gate';
import {
  shieldInWorker,
  buildUnsignedShieldInWorker,
  completeShieldInWorker,
  spawnNetworkWorker,
  type ShieldUnsignedResult,
} from '../../state/keyring/network-worker';
import {
  encodeZcashShieldingSignRequest,
  isZcashSignatureQR,
  parseZcashSignatureResponse,
} from '@repo/wallet/zcash-zigner';
import { QrDisplay } from '../../shared/components/qr-display';
import { QrScanner } from '../../shared/components/qr-scanner';
import { Sensitive } from '../sensitive';

/** mirrors home's fmtZec - trim trailing zeros, keep at least 2 decimals */
const fmtZec = (val: number): string => {
  if (val === 0) {
    return '0';
  }
  const s = val.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) {
    return `${s}.00`;
  }
  const decimals = s.length - dot - 1;
  return decimals < 2 ? s + '0'.repeat(2 - decimals) : s;
};

type ZignerStep =
  | 'idle'
  | 'building'
  | 'show_qr'
  | 'scanning'
  | 'broadcasting'
  | 'complete'
  | 'error';

export interface ShieldTransparentProps {
  /** transparent balance in zatoshi - parent hides this component at 0 */
  transparentZat: bigint;
  /** UTXO fetch still in flight - show a placeholder amount */
  utxoLoading: boolean;
  /** hot wallet (mnemonic vault) - enables one-tap shield */
  hasMnemonic?: boolean;
  /** watch-only wallet record - enables the zigner QR flow */
  watchOnly?: { label: string; mainnet: boolean; orchardFvk?: string; ufvk?: string; id?: string };
  /** derived transparent addresses (BIP44 order = derivation index) */
  tAddresses: string[];
  isMainnet: boolean;
  zidecarUrl: string;
}

export const ShieldTransparent = ({
  transparentZat,
  utxoLoading,
  hasMnemonic,
  watchOnly,
  tAddresses,
  isMainnet,
  zidecarUrl,
}: ShieldTransparentProps) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();

  // hot-wallet shielding state
  const [shielding, setShielding] = useState(false);
  const [shieldTxid, setShieldTxid] = useState<string | null>(null);
  const [shieldError, setShieldError] = useState<string | null>(null);

  // zigner shielding state
  const [zignerStep, setZignerStep] = useState<ZignerStep>('idle');
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const [unsignedData, setUnsignedData] = useState<ShieldUnsignedResult | null>(null);
  const [zignerTxid, setZignerTxid] = useState<string | null>(null);
  const [zignerError, setZignerError] = useState<string | null>(null);

  const handleShield = useCallback(async () => {
    if (!hasMnemonic || !selectedKeyInfo || selectedKeyInfo.type !== 'mnemonic') {
      return;
    }
    if (shielding || transparentZat <= 0n) {
      return;
    }

    const authorized = await requestAuth();
    if (!authorized) {
      return;
    }

    setShielding(true);
    setShieldTxid(null);
    setShieldError(null);

    try {
      const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
      const walletId = selectedKeyInfo.id;
      // map each address to its BIP44 derivation index so the worker signs with the correct key
      const addressIndexMap: Record<string, number> = {};
      tAddresses.forEach((addr, i) => {
        addressIndexMap[addr] = i;
      });
      const result = await shieldInWorker(
        'zcash',
        walletId,
        mnemonic,
        zidecarUrl,
        tAddresses,
        isMainnet,
        addressIndexMap,
      );
      setShieldTxid(result.txid);
    } catch (err) {
      setShieldError(err instanceof Error ? err.message : String(err));
    } finally {
      setShielding(false);
    }
  }, [
    hasMnemonic,
    selectedKeyInfo,
    keyRing,
    shielding,
    transparentZat,
    tAddresses,
    isMainnet,
    zidecarUrl,
    requestAuth,
  ]);

  const handleZignerShield = useCallback(async () => {
    if (!watchOnly || !selectedKeyInfo) {
      return;
    }
    const ufvk =
      watchOnly.ufvk ??
      (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
    if (!ufvk) {
      return;
    }

    setZignerStep('building');
    setZignerTxid(null);
    setZignerError(null);

    try {
      await spawnNetworkWorker('zcash');
      const addressIndexMap: Record<string, number> = {};
      tAddresses.forEach((addr, i) => {
        addressIndexMap[addr] = i;
      });

      const result = await buildUnsignedShieldInWorker(
        'zcash',
        selectedKeyInfo.id,
        zidecarUrl,
        tAddresses,
        isMainnet,
        ufvk,
        addressIndexMap,
      );
      setUnsignedData(result);

      // encode QR sign request
      const sighashBytes = result.sighashes.map(h => {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      });

      const qrHex = encodeZcashShieldingSignRequest({
        accountIndex: 0,
        sighashes: sighashBytes,
        addressIndices: result.addressIndices,
        summary: result.summary,
        mainnet: isMainnet,
      });

      setSignRequestQr(qrHex);
      setZignerStep('show_qr');
    } catch (err) {
      setZignerError(err instanceof Error ? err.message : String(err));
      setZignerStep('error');
    }
  }, [watchOnly, selectedKeyInfo, tAddresses, isMainnet, zidecarUrl]);

  const handleZignerSigScanned = useCallback(
    async (data: string) => {
      if (!isZcashSignatureQR(data)) {
        setZignerError('invalid signature QR code');
        setZignerStep('error');
        return;
      }

      try {
        const sigResponse = parseZcashSignatureResponse(data);

        if (!unsignedData || !selectedKeyInfo) {
          throw new Error('missing unsigned transaction data');
        }

        // verify the returned sighash matches what we sent
        const toHex = (b: Uint8Array) =>
          Array.from(b)
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
        const responseSighash = toHex(sigResponse.sighash);
        if (unsignedData.sighashes.length > 0 && responseSighash !== unsignedData.sighashes[0]) {
          throw new Error('sighash mismatch - signature is for a different transaction');
        }

        setZignerStep('broadcasting');

        // zigner returns each transparent sig as: DER_sig + 0x01(hashtype) + compressed_pubkey(33 bytes)
        // split into sig (with hashtype) and pubkey
        const signatures = sigResponse.transparentSigs.map(combined => {
          const pubkey = combined.slice(-33);
          const sig = combined.slice(0, -33);
          return { sig_hex: toHex(sig), pubkey_hex: toHex(pubkey) };
        });

        const result = await completeShieldInWorker(
          'zcash',
          selectedKeyInfo.id,
          zidecarUrl,
          unsignedData.unsignedTxHex,
          signatures,
        );

        setZignerTxid(result.txid);
        setZignerStep('complete');
      } catch (err) {
        setZignerError(err instanceof Error ? err.message : String(err));
        setZignerStep('error');
      }
    },
    [unsignedData, selectedKeyInfo, zidecarUrl],
  );

  const tZec = Number(transparentZat) / 1e8;

  return (
    <div className='rounded-md border border-border-soft bg-elev-1 px-4 py-2.5'>
      {PasswordModal}
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='i-ph-eye h-3.5 w-3.5 shrink-0 text-fg-muted' />
          <span className='text-xs text-fg-muted lowercase'>transparent</span>
          <span className='rounded-sm bg-elev-2 px-1.5 py-0.5 text-label text-fg-dim leading-none lowercase'>
            public
          </span>
          <Sensitive className='truncate text-xs tabular text-fg-high'>
            {utxoLoading ? '...' : `${fmtZec(tZec)} ZEC`}
          </Sensitive>
        </div>
        {hasMnemonic ? (
          <button
            type='button'
            onClick={() => void handleShield()}
            disabled={shielding || !!shieldTxid}
            className='shrink-0 text-xs font-medium text-network-accent transition-colors hover:text-fg-high disabled:opacity-50'
          >
            {shielding ? 'shielding...' : shieldTxid ? 'pending...' : 'shield'}
          </button>
        ) : (
          <button
            type='button'
            onClick={() => void handleZignerShield()}
            disabled={zignerStep !== 'idle' && zignerStep !== 'error' && zignerStep !== 'complete'}
            className='shrink-0 text-xs font-medium text-network-accent transition-colors hover:text-fg-high disabled:opacity-50'
          >
            {zignerStep === 'building'
              ? 'building...'
              : zignerStep === 'broadcasting'
                ? 'broadcasting...'
                : zignerStep === 'complete'
                  ? 'pending...'
                  : 'shield via zigner'}
          </button>
        )}
      </div>

      {shieldTxid && (
        <div className='mt-1.5 font-mono text-label text-fg-muted'>
          shielded: {shieldTxid.slice(0, 16)}... (wait for confirmation)
        </div>
      )}
      {shieldError && <div className='mt-1.5 text-label text-warning'>{shieldError}</div>}

      {/* zigner shielding QR flow */}
      {zignerStep === 'show_qr' && signRequestQr && (
        <div className='mt-3 flex flex-col items-center gap-2'>
          <QrDisplay
            data={signRequestQr}
            size={180}
            title='scan with zafu zigner'
            description='scan to sign shielding transaction'
          />
          <div className='flex w-full gap-2'>
            <button
              onClick={() => setZignerStep('scanning')}
              className='flex-1 bg-zigner-gold py-1.5 text-xs font-medium text-zigner-dark transition-colors hover:bg-primary/90'
            >
              scan signature
            </button>
            <button
              onClick={() => {
                setZignerStep('idle');
                setSignRequestQr(null);
              }}
              className='px-2 text-xs text-fg-muted transition-colors hover:text-fg-high'
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {zignerStep === 'scanning' && (
        <div className='mt-3'>
          <QrScanner
            onScan={data => void handleZignerSigScanned(data)}
            onError={err => {
              setZignerError(err);
              setZignerStep('error');
            }}
            onClose={() => setZignerStep('show_qr')}
            title='scan signature'
            description='point camera at zafu zigner signature qr'
          />
        </div>
      )}

      {zignerStep === 'complete' && zignerTxid && (
        <div className='mt-1.5 font-mono text-label text-fg-muted'>
          shielded: {zignerTxid.slice(0, 16)}... (wait for confirmation)
        </div>
      )}
      {zignerStep === 'error' && zignerError && (
        <div className='mt-1.5 text-label text-warning'>
          {zignerError}
          <button
            onClick={() => {
              setZignerStep('idle');
              setZignerError(null);
            }}
            className='ml-2 underline'
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
};

export default ShieldTransparent;
