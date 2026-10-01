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
import { activeAccountIndex, activePockets, activeZcashStoreId } from '../../state/pockets';
import { usePasswordGate } from '../../hooks/password-gate';
import { Button } from '@repo/ui/components/ui/button';
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
  /** the pocket's t-addresses; position is the derivation index the worker signs with */
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
  const storeId = useStore(activeZcashStoreId);
  const keyRing = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const account = useStore(activeAccountIndex);
  const pocketName = useStore(
    s => activePockets(s).find(p => p.account === account)?.name ?? 'main',
  );

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
      const vault = await keyRing.getVaultUnlock(selectedKeyInfo.id);
      const result = await shieldInWorker(
        'zcash',
        storeId ?? selectedKeyInfo.id,
        vault,
        zidecarUrl,
        tAddresses,
        isMainnet,
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
    storeId,
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
      const result = await buildUnsignedShieldInWorker(
        'zcash',
        selectedKeyInfo.id,
        zidecarUrl,
        tAddresses,
        isMainnet,
        ufvk,
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
  const busy =
    shielding || (zignerStep !== 'idle' && zignerStep !== 'error' && zignerStep !== 'complete');
  const done = !!shieldTxid || zignerStep === 'complete';
  const txid = shieldTxid ?? zignerTxid;
  const error = shieldError ?? (zignerStep === 'error' ? zignerError : null);

  // zigner's QR round trip takes over the sheet in place of the review -
  // nothing here expands, it swaps.
  if (zignerStep === 'show_qr' && signRequestQr) {
    return (
      <div className='flex flex-col items-center gap-3'>
        <QrDisplay
          data={signRequestQr}
          size={180}
          title='scan with zafu zigner'
          description='scan to sign shielding transaction'
        />
        <div className='flex w-full gap-2'>
          <Button onClick={() => setZignerStep('scanning')} className='flex-1'>
            scan signature
          </Button>
          <Button
            variant='secondary'
            onClick={() => {
              setZignerStep('idle');
              setSignRequestQr(null);
            }}
          >
            cancel
          </Button>
        </div>
      </div>
    );
  }

  if (zignerStep === 'scanning') {
    return (
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
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {PasswordModal}
      <div className='flex items-center justify-center gap-4 pt-1'>
        <span className='grid size-11 shrink-0 place-items-center border border-warn text-sm text-warn'>
          t
        </span>
        <span className='i-ph-arrow-right size-5 text-fg-muted' />
        <span className='grid size-11 shrink-0 place-items-center bg-network-accent text-sm text-zigner-gold-foreground'>
          z
        </span>
      </div>

      <div className='text-center'>
        <Sensitive className='text-3xl tabular-nums text-fg-high'>
          {utxoLoading ? '...' : fmtZec(tZec)}
          <span className='ml-1.5 text-base text-zigner-gold'>zec</span>
        </Sensitive>
      </div>

      <div className='divide-y divide-border-soft border border-border-soft bg-elev-1'>
        <div className='flex items-center justify-between px-4 py-3 text-sm'>
          <span className='text-fg-muted'>from</span>
          <span>
            {tAddresses.length} transparent address{tAddresses.length === 1 ? '' : 'es'}
          </span>
        </div>
        <div className='flex items-center justify-between px-4 py-3 text-sm'>
          <span className='text-fg-muted'>into</span>
          <span>{pocketName} pocket · shielded</span>
        </div>
        <div className='flex items-center justify-between px-4 py-3 text-sm'>
          <span className='text-fg-muted'>fee</span>
          <span>0.0001 zec</span>
        </div>
      </div>

      <p className='text-label text-fg-muted lowercase'>after this, these funds stay private</p>

      {txid && !error && (
        <p className='font-mono text-label text-fg-muted'>
          shielded: {txid.slice(0, 16)}... (wait for confirmation)
        </p>
      )}
      {error && (
        <p className='text-label text-warning'>
          {error}
          <button
            onClick={() => {
              setShieldError(null);
              setZignerStep('idle');
              setZignerError(null);
            }}
            className='ml-2 underline'
          >
            dismiss
          </button>
        </p>
      )}

      <Button
        onClick={() => void (hasMnemonic ? handleShield() : handleZignerShield())}
        loading={busy}
        disabled={busy || done || transparentZat <= 0n}
        className='w-full'
      >
        {done ? 'pending...' : hasMnemonic ? 'shield' : 'shield via zigner'}
      </Button>
    </div>
  );
};

export default ShieldTransparent;
