/**
 * Settings screen: Zigner device protocol-module / firmware OTA.
 *
 * Shows real device firmware info ONLY from verified records, and drives the
 * wallet-side update flow:
 *
 *   check → verifyStream (pinned key) → "signed & verified — upgrade?" Y/N
 *   → animated ur:zafu-stream QR → scan device's ur:zafu-result → verify →
 *   record (source: 'ur:zafu-result').
 *
 * The device update is a small signed protocol module (wasm), not a whole
 * firmware/kernel replacement — copy and the stream size cap reflect that.
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { otaSelector } from '../../../state/ota';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { Button } from '@repo/ui/components/ui/button';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { STREAM_UR_TYPE, RESULT_UR_TYPE, STATUS_UR_TYPE } from '../../../ota/ur';
import { SessionPhase } from '../../../ota/types';
import { toHex } from '../../../ota/util';

type ScanMode = 'none' | 'result' | 'status';

export const SettingsOta = () => {
  const {
    firmwareRecords,
    targetZid,
    session,
    pendingUpdate,
    lastResult,
    reconciliationNote,
    loadRecords,
    checkForUpdate,
    approveUpdate,
    confirmShown,
    onResultScanned,
    onStatusScanned,
    abortSession,
  } = useStore(otaSelector);

  const [scanMode, setScanMode] = useState<ScanMode>('none');
  const [checking, setChecking] = useState(false);

  const record = firmwareRecords[targetZid];
  const phase = session.phase;

  const handleCheck = async () => {
    setChecking(true);
    await loadRecords();
    await checkForUpdate();
    setChecking(false);
  };

  const recordInfo = record ? (
    <div className='rounded-md border border-elev-1 bg-elev-0 p-3 text-data text-fg'>
      <p className='text-fg-muted'>device firmware (verified)</p>
      <p>
        version <span className='font-mono text-fg-high'>{record.fw}</span> · slot {record.slot}
      </p>
      <p className='text-label text-fg-muted'>
        applied {new Date(record.applied_at).toLocaleString()} · session {record.session}
      </p>
      {record.feature_set.length > 0 ? (
        <p className='text-label text-fg-muted'>capabilities: {record.feature_set.join(', ')}</p>
      ) : (
        <p className='text-label text-fg-muted'>no capabilities offered (fail-closed)</p>
      )}
    </div>
  ) : (
    <p className='text-data text-fg-muted'>no verified device firmware record yet.</p>
  );

  const streamInline =
    phase === SessionPhase.AwaitingTap && pendingUpdate ? (
      <div className='flex flex-col items-center gap-3'>
        <AnimatedQrDisplay
          urFrames={pendingUpdate.streamFrames}
          urType={STREAM_UR_TYPE}
          totalBytes={pendingUpdate.manifest.payload_size}
          title={`signed update v${pendingUpdate.manifest.version} — hold to device`}
          description='device protocol module update, ~1 min scan. scan the animated QR with the device, then tap to apply.'
        />
        <Button onClick={confirmShown}>stream shown — awaiting device result</Button>
      </div>
    ) : null;

  const resultScanner =
    phase === SessionPhase.AwaitingResult && scanMode === 'result' ? (
      <AnimatedQrScanner
        inline
        urTypeFilter={RESULT_UR_TYPE}
        title='scan device result (ur:zafu-result)'
        onComplete={bytes => {
          setScanMode('none');
          void onResultScanned(bytes);
        }}
        onError={msg => console.warn('[ota] result scan error', msg)}
        onClose={() => setScanMode('none')}
      />
    ) : null;

  const statusScanner = scanMode === 'status' ? (
    <AnimatedQrScanner
      inline
      urTypeFilter={STATUS_UR_TYPE}
      title='scan device status (ur:zafu-status)'
      onComplete={bytes => {
        setScanMode('none');
        void onStatusScanned(bytes);
      }}
      onError={msg => console.warn('[ota] status scan error', msg)}
      onClose={() => setScanMode('none')}
    />
  ) : null;

  return (
    <SettingsScreen title='device update' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <p className='text-label text-fg-muted'>
          devices: <span className='font-mono'>{targetZid.slice(0, 10)}…</span>
        </p>

        {recordInfo}

        {reconciliationNote && (
          <p className='rounded-md bg-elev-0 p-2 text-label text-fg-muted'>{reconciliationNote}</p>
        )}

        {phase === SessionPhase.Error && (
          <p className='rounded-md bg-red-500/10 p-2 text-label text-red-300'>
            {session.error ?? 'ota session failed'}
          </p>
        )}

        {phase === SessionPhase.Idle && (
          <div className='flex flex-col gap-2'>
            <Button onClick={() => void handleCheck()} disabled={checking}>
              {checking ? 'checking…' : 'check for update'}
            </Button>
            <Button variant='secondary' size='sm' onClick={() => setScanMode('status')}>
              reconcile with device status (ur:zafu-status)
            </Button>
          </div>
        )}

        {phase === SessionPhase.Streaming && pendingUpdate && (
          <div className='flex flex-col gap-3 rounded-md border border-green-500/30 bg-green-500/5 p-3'>
            <p className='text-data text-fg-high'>
              signed &amp; verified — upgrade to v{pendingUpdate.manifest.version}?
            </p>
            <p className='text-label text-fg-muted'>
              device protocol module update (wasm, ~1 min scan). key_id{' '}
              {pendingUpdate.manifest.key_id} · class {pendingUpdate.manifest.class} ·{' '}
              {pendingUpdate.manifest.payload_size} bytes
            </p>
            <div className='flex gap-2'>
              <Button onClick={approveUpdate}>yes, upgrade</Button>
              <Button variant='secondary' onClick={() => abortSession('declined')}>
                no
              </Button>
            </div>
          </div>
        )}

        {streamInline}

        {phase === SessionPhase.AwaitingResult && scanMode === 'none' && (
          <Button onClick={() => setScanMode('result')}>scan device result</Button>
        )}
        {resultScanner}

        {statusScanner}

        {phase === SessionPhase.Recorded && lastResult && (
          <div className='rounded-md border border-green-500/30 bg-green-500/5 p-3 text-data text-fg'>
            <p className='text-fg-high'>update recorded ✓</p>
            <p>
              fw v{lastResult.fw_version} · slot {lastResult.slot} ·{' '}
              {lastResult.success ? 'successful-boot confirmed' : 'not confirmed'}
            </p>
            <p className='text-label text-fg-muted'>session {toHex(lastResult.req_id)}</p>
            <Button variant='secondary' size='sm' onClick={() => abortSession()} className='mt-2'>
              done
            </Button>
          </div>
        )}

        {(phase === SessionPhase.AwaitingTap || phase === SessionPhase.AwaitingResult) && (
          <Button
            variant='secondary'
            size='sm'
            onClick={() => abortSession('aborted by user')}
            className='self-start'
          >
            abort (device state untouched)
          </Button>
        )}

        <p className='text-xs text-fg-dim'>dev-only stub update endpoint (not for release)</p>
      </div>
    </SettingsScreen>
  );
};
