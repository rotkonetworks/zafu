/**
 * One device scanner for zigner / keystone.
 *
 * Replaces the four hand-rolled copies of "scan a zigner/keystone QR, then
 * add-or-merge a wallet" (onboarding's import-zigner, settings-zigner,
 * settings-wallets, and the developer paste modes each of those carried).
 * One code carries one network; the found screen lets a second code join
 * the same wallet (see connect-device.ts / mergeZignerCapabilities).
 *
 * States: scan (camera + a visible paste fallback, never hidden behind a
 * tap-counter) -> result (found or joined, same screen - `joined` only
 * changes the copy) -> done. An unreadable code shows its reason inline in
 * the scan screen's status slot and never advances.
 */

import { useCallback, useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../state';
import { keyRingSelector } from '../../state/keyring';
import { ZCASH_ORCHARD_ACTIVATION } from '../../config/networks';
import { describeZcashHeight } from '../../utils/zcash-blocks';
import { QrScanner } from '../../shared/components/qr-scanner';
import { AnimatedQrScanner } from '../../shared/components/animated-qr-scanner';
import {
  parseConnectCode,
  parseConnectCodeBytes,
  type ConnectDevice,
  type ParsedConnectCode,
} from './parse-connect-code';
import { connectDevice, findJoinTarget, type ConnectOutcome } from './connect-device';

/** a payload that opens a multi-frame (fountain) UR sequence, e.g. a keystone export too large for one QR */
const MULTIPART_UR = /^ur:[^/]+\/\d+-\d+\//i;

type ScreenState =
  | { kind: 'scan'; error?: string; multipart?: boolean }
  | { kind: 'result'; parsed: ParsedConnectCode; joined: boolean }
  | { kind: 'connecting' }
  | { kind: 'done'; outcome: ConnectOutcome };

const networkLabel = (n: ParsedConnectCode['network']) => (n === 'zcash' ? 'zcash' : 'penumbra');
const otherNetwork = (n: ParsedConnectCode['network']): ParsedConnectCode['network'] =>
  n === 'zcash' ? 'penumbra' : 'zcash';

export interface DeviceScannerProps {
  /** called once the wallet has been added/merged and the user is done */
  onDone: (outcome: ConnectOutcome) => void;
  onCancel: () => void;
}

export const DeviceScanner = ({ onDone, onCancel }: DeviceScannerProps) => {
  const { keyInfos, addZignerUnencrypted } = useStore(keyRingSelector);
  const [screen, setScreen] = useState<ScreenState>({ kind: 'scan' });
  const [showPaste, setShowPaste] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [label, setLabel] = useState('');
  const [startBlock, setStartBlock] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  // the found screen's "is it a keystone instead?" swap
  const [deviceOverride, setDeviceOverride] = useState<ConnectDevice | null>(null);
  // once the current device's other network has been offered "scan next",
  // remember it joined the same device rather than re-deriving from scratch
  const knownNetworksRef = useRef<Set<ParsedConnectCode['network']>>(new Set());

  const startBlockNum = parseInt(startBlock, 10);
  const startBlockHint = startBlock.trim() ? describeZcashHeight(startBlockNum) : null;
  const startBlockOk = !startBlock.trim() || (startBlockHint?.ok ?? false);

  const handlePayload = useCallback(
    (raw: string, origin: 'camera' | 'paste') => {
      const result = parseConnectCode(raw);
      if (!result.ok) {
        if (MULTIPART_UR.test(raw.trim())) {
          // a single frame of a fountain-coded code. the camera can keep
          // reading the rest; a paste has no more frames to give.
          if (origin === 'camera') {
            setScreen({ kind: 'scan', multipart: true });
          } else {
            setScreen({
              kind: 'scan',
              error: 'this code spans several frames. please use the camera instead of pasting.',
            });
          }
          return;
        }
        setScreen({ kind: 'scan', error: result.message });
        return;
      }
      const joined = Boolean(findJoinTarget(result, keyInfos));
      setLabel(result.label ?? '');
      setDeviceOverride(null);
      setScreen({ kind: 'result', parsed: result, joined });
    },
    [keyInfos],
  );

  const handleMultipartComplete = useCallback(
    (bytes: Uint8Array, urType: string) => {
      if (urType !== 'zcash-accounts') {
        setScreen({ kind: 'scan', error: `unsupported code: ur:${urType}.` });
        return;
      }
      const result = parseConnectCodeBytes(bytes);
      if (!result.ok) {
        setScreen({ kind: 'scan', error: result.message });
        return;
      }
      const joined = Boolean(findJoinTarget(result, keyInfos));
      setLabel(result.label ?? '');
      setDeviceOverride(null);
      setScreen({ kind: 'result', parsed: result, joined });
    },
    [keyInfos],
  );

  const handlePasteSubmit = () => {
    if (!pasteValue.trim()) {
      return;
    }
    handlePayload(pasteValue, 'paste');
  };

  const handleAdd = async () => {
    if (screen.kind !== 'result') {
      return;
    }
    const parsed: ParsedConnectCode =
      deviceOverride && screen.parsed.network === 'zcash'
        ? { ...screen.parsed, device: deviceOverride }
        : screen.parsed;
    setConnectError(null);
    setScreen({ kind: 'connecting' });
    try {
      const birthday =
        parsed.network === 'zcash' && startBlock.trim() && startBlockOk
          ? Math.max(ZCASH_ORCHARD_ACTIVATION, startBlockNum)
          : undefined;
      const outcome = await connectDevice(parsed, {
        label,
        birthday,
        keyInfos,
        addZignerUnencrypted,
      });
      knownNetworksRef.current.add(parsed.network);
      setScreen({ kind: 'done', outcome });
      onDone(outcome);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConnectError(message);
      setScreen({ kind: 'result', parsed: screen.parsed, joined: screen.joined });
    }
  };

  const scanAnother = () => {
    setConnectError(null);
    setStartBlock('');
    setScreen({ kind: 'scan' });
  };

  if (screen.kind === 'scan' && screen.multipart) {
    return (
      <AnimatedQrScanner
        onComplete={handleMultipartComplete}
        onError={message => setScreen({ kind: 'scan', error: message })}
        onClose={() => setScreen({ kind: 'scan' })}
        inline
        title='reading device code'
        description='hold the camera steady - this code spans several frames'
        urTypeFilter='zcash-accounts'
      />
    );
  }

  if (screen.kind === 'scan') {
    return (
      <div className='flex flex-col gap-4'>
        {!showPaste && (
          <QrScanner
            onScan={data => handlePayload(data, 'camera')}
            onError={message => setScreen({ kind: 'scan', error: message })}
            onClose={onCancel}
            inline
            title='scan your device'
            description='zafu tells which network this is for'
          />
        )}

        {screen.error && (
          <StatusSlot tone='warn' icon='i-ph-warning-circle'>
            <span>{screen.error}</span>
          </StatusSlot>
        )}

        <button
          type='button'
          onClick={() => setShowPaste(v => !v)}
          className='text-label text-fg-muted underline-offset-2 hover:underline lowercase'
        >
          {showPaste ? 'use the camera instead' : 'paste the code instead'}
        </button>

        {showPaste && (
          <div className='flex flex-col gap-2'>
            <textarea
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              placeholder='paste the connect code'
              rows={4}
              spellCheck={false}
              className='w-full resize-none border border-border-soft bg-elev-1 p-2 font-mono text-[11px] leading-snug text-fg-high outline-none focus:border-zigner-gold'
            />
            <Button variant='primary' onClick={handlePasteSubmit} disabled={!pasteValue.trim()}>
              read code
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (screen.kind === 'connecting') {
    return (
      <div className='flex flex-col items-center gap-3 py-10 text-fg-muted'>
        <span className='i-ph-circle-notch size-5 animate-spin' />
        <span className='text-xs lowercase'>connecting...</span>
      </div>
    );
  }

  if (screen.kind === 'done') {
    return (
      <StatusSlot tone='gold' icon='i-ph-check-circle'>
        <span className='text-fg-high'>
          {networkLabel(screen.outcome.network)} added
          {screen.outcome.joined ? ' to this wallet' : ''}
        </span>
      </StatusSlot>
    );
  }

  // result: found or joined
  const { parsed, joined } = screen;
  const effectiveDevice: ConnectDevice =
    deviceOverride && parsed.network === 'zcash' ? deviceOverride : parsed.device;
  const companion = otherNetwork(parsed.network);
  // keystone only ever carries zcash - no companion network to offer
  const offerCompanion = effectiveDevice === 'zigner' && !knownNetworksRef.current.has(companion);

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex items-center gap-3'>
        <span className='flex size-11 shrink-0 items-center justify-center border border-blue-500/30'>
          <span
            className={parsed.network === 'zcash' ? 'i-ph-scan size-6' : 'i-ph-cube size-6'}
            style={{ color: 'var(--zigner-gold, #f4b728)' }}
          />
        </span>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='text-data text-fg-high lowercase'>
            {effectiveDevice} {joined ? 'joined' : 'found'}
          </span>
          {parsed.network === 'zcash' && (
            <button
              type='button'
              onClick={() =>
                setDeviceOverride(effectiveDevice === 'zigner' ? 'keystone' : 'zigner')
              }
              className='text-label text-fg-muted underline-offset-2 hover:underline lowercase'
            >
              is it a {effectiveDevice === 'zigner' ? 'keystone' : 'zigner'} instead?
            </button>
          )}
        </div>
      </div>

      <RowGroup>
        <div className='flex min-h-[52px] items-center gap-3 px-3.5 py-2'>
          <span className='size-2.5 shrink-0 bg-zigner-gold' />
          <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
            <span className='text-data text-fg-high lowercase'>{networkLabel(parsed.network)}</span>
            <span className='text-label text-fg-muted lowercase'>
              {joined ? 'already in this wallet' : 'from this code'}
            </span>
          </div>
        </div>
        {offerCompanion && (
          <div className='flex min-h-[52px] items-center gap-3 border-t border-border-soft px-3.5 py-2'>
            <span className='size-2.5 shrink-0 border border-dashed border-border' />
            <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='text-data text-fg-muted lowercase'>{networkLabel(companion)}</span>
              <span className='text-label text-fg-muted lowercase'>scan its code next</span>
            </div>
            <Button variant='secondary' size='sm' onClick={scanAnother}>
              scan next
            </Button>
          </div>
        )}
      </RowGroup>

      <Input placeholder='wallet name' value={label} onChange={e => setLabel(e.target.value)} />

      {parsed.network === 'zcash' && (
        <div className='flex flex-col gap-1'>
          <label className='text-label text-fg-muted lowercase'>
            start block (optional) - blank syncs from near the chain tip
          </label>
          <Input
            type='text'
            inputMode='numeric'
            placeholder='e.g. 2910104'
            value={startBlock}
            onChange={e => setStartBlock(e.target.value)}
            className='font-mono text-xs'
          />
          {startBlockHint && (
            <p className={startBlockHint.ok ? 'text-label text-fg-dim' : 'text-label text-hanko'}>
              {startBlockHint.text}
            </p>
          )}
        </div>
      )}

      {connectError && (
        <StatusSlot tone='danger' icon='i-ph-warning-circle'>
          <span>{connectError}</span>
        </StatusSlot>
      )}

      <div className='flex gap-2'>
        <Button variant='secondary' className='flex-1' onClick={scanAnother}>
          scan again
        </Button>
        <Button
          variant='primary'
          className='flex-1'
          disabled={!startBlockOk}
          onClick={() => void handleAdd()}
        >
          {joined ? 'add to this wallet' : 'add wallet'}
        </Button>
      </div>
    </div>
  );
};
