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
 *   - ledger (zcash app): rounds of at most 32 inputs, one device approval
 *     each, checkpointed before broadcast (ledger/zcash-app/shielding-rounds)
 *
 * Self-contained: reads the active vault + keyring from the store and owns
 * its own password gate, so the parent only passes display/network inputs.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '../../state';
import { zcashViewKey } from '../../state/zcash-view-key';
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
import { HARDWARE_WALLET_ENABLED } from '../../config/feature-flags';
import { walletKind } from '../../signing/wallet-kind';
import { isPopup } from '../../utils/popup-detection';
import type { LedgerSigningPhase, LedgerZcashDevice } from '../../ledger/zcash-app/contract';
import { openLedger } from '../../ledger/zcash-app/connect';
import { ledgerGuidance } from '../../ledger/zcash-app/guidance';
import { loadLedgerZcashProtocol } from '../../ledger/zcash-app/protocol';
import { recoverLedgerOperations } from '../../ledger/zcash-app/recovery';
import { LedgerShieldingSession } from '../../ledger/zcash-app/shielding-rounds';
import {
  accountStamper,
  ledgerAccountFromKeyInfo,
  ledgerNetwork,
  zafuRecoveryDeps,
  zafuShieldingDeps,
} from '../../ledger/zcash-app/zafu-deps';
import { LedgerSteps } from '../../routes/popup/send/send-states';
import { Proving, SendingFooter, type SendingNote } from '../../routes/popup/send/send-ui';
import { STAGES, sendStage, type SendProgress } from '../../routes/popup/send/send-stage';
import { isHeartbeat, phaseOf, useSendWatch, watchNote } from '../../routes/popup/send/send-watch';
import { stopBuildInWorker } from '../../state/keyring/network-worker';
import { isBuildStopped } from '../../workers/build-abort';

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
  /** how many of them hold funds right now (each swap has its own address) */
  funded?: number;
  isMainnet: boolean;
  zidecarUrl: string;
}

export const ShieldTransparent = ({
  transparentZat,
  utxoLoading,
  hasMnemonic,
  watchOnly,
  tAddresses,
  funded,
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

  // the build in the worker (hot shield or zigner's unsigned build), with the
  // same progress, stop and stall handling as the send screen
  const buildKeyRef = useRef<string | null>(null);
  const [buildSteps, setBuildSteps] = useState<SendProgress[]>([]);
  const [buildSince, setBuildSince] = useState(0);
  const [buildNote, setBuildNote] = useState<Exclude<SendingNote, 'slow' | 'rerouting'>>('leave');
  const building = shielding || zignerStep === 'building';
  const startBuild = () => {
    const key = crypto.randomUUID();
    buildKeyRef.current = key;
    setBuildSteps([]);
    setBuildSince(Date.now());
    setBuildNote('leave');
    return key;
  };
  useEffect(() => {
    if (!building) {
      return;
    }
    const onProgress = (e: Event) => {
      const { step, detail } = (e as CustomEvent<SendProgress>).detail;
      setBuildSteps(prev => [...prev, { step, detail }]);
    };
    window.addEventListener('zcash-send-progress', onProgress);
    return () => window.removeEventListener('zcash-send-progress', onProgress);
  }, [building]);
  const watch = useSendWatch(buildSteps, buildSince, building);
  const stopBuild = async (failed?: string) => {
    const key = buildKeyRef.current;
    if (!key) {
      return;
    }
    setBuildNote('stopping');
    const outcome = await stopBuildInWorker('zcash', key);
    if (outcome === 'committed') {
      setBuildNote('on-its-way');
      return;
    }
    buildKeyRef.current = null;
    setBuildNote('leave');
    setShielding(false);
    setZignerStep(failed ? 'error' : 'idle');
    if (failed) {
      setZignerError(failed);
    }
  };
  useEffect(() => {
    if (watch !== 'timeout') {
      return;
    }
    const quietAt = buildSteps.findLast(p => !isHeartbeat(p.step))?.step;
    if (phaseOf(quietAt) !== 'broadcast') {
      void stopBuild('this took far longer than it should, so zafu stopped it · nothing was moved');
    }
    // once per timeout
  }, [watch]);

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

    const key = startBuild();
    try {
      const vault = await keyRing.getVaultUnlock(selectedKeyInfo.id);
      const result = await shieldInWorker(
        'zcash',
        storeId ?? selectedKeyInfo.id,
        vault,
        zidecarUrl,
        tAddresses,
        isMainnet,
        key,
      );
      setShieldTxid(result.txid);
    } catch (err) {
      if (!isBuildStopped(err)) {
        setShieldError(err instanceof Error ? err.message : String(err));
      }
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
    const ufvk = zcashViewKey(watchOnly);
    if (!ufvk) {
      return;
    }

    setZignerStep('building');
    setZignerTxid(null);
    setZignerError(null);
    const key = startBuild();

    try {
      await spawnNetworkWorker('zcash');
      const result = await buildUnsignedShieldInWorker(
        'zcash',
        selectedKeyInfo.id,
        zidecarUrl,
        tAddresses,
        isMainnet,
        ufvk,
        undefined,
        key,
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
      if (isBuildStopped(err)) {
        return;
      }
      setZignerError(err instanceof Error ? err.message : String(err));
      setZignerStep('error');
    }
  }, [watchOnly, selectedKeyInfo, tAddresses, isMainnet, zidecarUrl]);

  const handleZignerSigScanned = useCallback(
    async (data: string) => {
      if (!isZcashSignatureQR(data)) {
        setZignerError("that code isn't zigner's answer · please scan again");
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

  const ledger = useLedgerShield({ watchOnly, tAddresses, isMainnet, zidecarUrl });
  const method =
    HARDWARE_WALLET_ENABLED &&
    selectedKeyInfo &&
    walletKind(selectedKeyInfo, {
      transparentAddress: selectedKeyInfo.insensitive['transparentAddress'] as string | undefined,
    }) === 'ledger-shielded'
      ? 'ledger'
      : hasMnemonic
        ? 'hot'
        : 'zigner';
  const ACTION = {
    hot: { run: handleShield, label: 'shield' },
    zigner: { run: handleZignerShield, label: 'shield via zigner' },
    ledger: { run: ledger.run, label: 'shield with ledger' },
  }[method];

  const tZec = Number(transparentZat) / 1e8;
  const busy =
    shielding ||
    !!ledger.phase ||
    (zignerStep !== 'idle' && zignerStep !== 'error' && zignerStep !== 'complete');
  const done = !!shieldTxid || zignerStep === 'complete' || !!ledger.txid;
  const txid = shieldTxid ?? zignerTxid ?? ledger.txid;
  const error = shieldError ?? ledger.error ?? (zignerStep === 'error' ? zignerError : null);

  // the device steps take the sheet while a round asks the ledger
  if (ledger.phase) {
    return (
      <div className='flex flex-col gap-4'>
        {ledger.round && ledger.round.of > 1 && (
          <p className='text-label text-fg-muted'>
            transaction {ledger.round.n} of {ledger.round.of} · each is approved and pays its own
            fee
          </p>
        )}
        <LedgerSteps phase={ledger.phase} />
        <Button variant='secondary' onClick={ledger.stop} className='w-full'>
          not now
        </Button>
      </div>
    );
  }

  // a build in the worker swaps in the sending screen's stages, with a quiet
  // stop while nothing has left
  if (building) {
    return (
      <div className='-mx-4 flex flex-col'>
        {PasswordModal}
        <Proving
          stages={STAGES.zcash}
          steps={buildSteps}
          floor={0}
          since={buildSince}
          hot={method === 'hot'}
        />
        <SendingFooter
          note={buildNote !== 'leave' ? buildNote : watchNote(watch)}
          onStop={
            buildNote !== 'on-its-way' && sendStage(STAGES.zcash, buildSteps) < 3
              ? () => void stopBuild()
              : undefined
          }
        />
      </div>
    );
  }

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
            {funded ?? 'your'} transparent address{funded === 1 ? '' : 'es'}
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

      {/* hot and ledger shield one address per transaction; zigner signs them all in one */}
      {!!funded && funded > 1 && (
        <p className='text-label text-fg-muted lowercase'>
          {method === 'zigner'
            ? `these ${funded} addresses are shielded together in one transaction · that links them on chain`
            : `each address is shielded in its own transaction, each with its own fee · they stay unlinked`}
        </p>
      )}
      <p className='text-label text-fg-muted lowercase'>after this, these funds stay private</p>

      {txid && !error && (
        <p className='font-mono text-label text-fg-muted'>
          shielded:{' '}
          <Clipped head={16} tail={0} label='transaction id'>
            {txid}
          </Clipped>{' '}
          (wait for confirmation)
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
              ledger.dismiss();
            }}
            className='ml-2 underline'
          >
            dismiss
          </button>
        </p>
      )}

      <Button
        onClick={() => void ACTION.run()}
        loading={busy}
        disabled={busy || done || transparentZat <= 0n}
        className='w-full'
      >
        {done ? 'pending...' : ACTION.label}
      </Button>
    </div>
  );
};

/**
 * One Ledger shielding session per sheet: a failed round is retried by running
 * again, reusing its signed bytes; the session ends when it completes or pauses.
 */
function useLedgerShield({
  watchOnly,
  tAddresses,
  isMainnet,
  zidecarUrl,
}: Pick<ShieldTransparentProps, 'watchOnly' | 'tAddresses' | 'isMainnet' | 'zidecarUrl'>) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const storeId = useStore(activeZcashStoreId);
  const [phase, setPhase] = useState<LedgerSigningPhase['phase'] | null>(null);
  const [round, setRound] = useState<{ n: number; of: number }>();
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<LedgerShieldingSession | null>(null);
  const device = useRef<LedgerZcashDevice | null>(null);
  const abort = useRef<AbortController | null>(null);

  const end = async () => {
    session.current = null;
    const d = device.current;
    device.current = null;
    await d?.close().catch(() => undefined);
  };
  useEffect(
    () => () => {
      abort.current?.abort();
      void end();
    },
    [],
  );

  const run = async () => {
    const ufvk = zcashViewKey(watchOnly);
    if (!selectedKeyInfo || !ufvk) {
      return;
    }
    setError(null);
    setPhase('connecting');
    const ac = new AbortController();
    abort.current = ac;
    try {
      if (isPopup()) {
        throw new Error(
          'please open zafu in a tab or the side panel to sign with a ledger · the toolbar popup closes when the device asks for focus',
        );
      }
      // the device picker may need this click, so it is asked first
      device.current ??= await openLedger();
      if (!session.current) {
        const ins = selectedKeyInfo.insensitive;
        const ctx = { walletId: storeId ?? selectedKeyInfo.id, network: ledgerNetwork(isMainnet) };
        await spawnNetworkWorker('zcash');
        await recoverLedgerOperations(zafuRecoveryDeps(zidecarUrl), ctx);
        const protocol = await loadLedgerZcashProtocol();
        const account = ledgerAccountFromKeyInfo(ins, Number(ins['accountIndex'] ?? 0));
        session.current = new LedgerShieldingSession(
          zafuShieldingDeps({
            protocol,
            device: device.current,
            stampDerivations: accountStamper(protocol, account),
            ctx,
            serverUrl: zidecarUrl,
            isCurrent: () => selectEffectiveKeyInfo(useStore.getState())?.id === selectedKeyInfo.id,
            ufvk,
            tAddresses,
            mainnet: isMainnet,
          }),
          ctx,
        );
      }
      const out = await session.current.run({
        signal: ac.signal,
        onPhase: p => setPhase(p.phase),
        onProgress: p => {
          if (p.step === 'preparing') {
            setPhase('connecting');
          }
          if (p.totalRounds > 0) {
            setRound({ n: p.round, of: p.totalRounds });
          }
        },
      });
      await end();
      setTxid(out.txids.at(-1) ?? null);
      if (out.status === 'paused') {
        setError(out.message);
      }
    } catch (e) {
      const g = ledgerGuidance(e);
      setError(`${g.title} · ${g.action}`);
      if (!g.retryable) {
        await end();
      }
    } finally {
      abort.current = null;
      setPhase(null);
    }
  };

  return {
    run,
    phase,
    round,
    txid,
    error,
    stop: () => abort.current?.abort(),
    dismiss: () => setError(null),
  };
}

export default ShieldTransparent;
