/**
 * Shared UI bits for the multisig create/join (DKG) flows.
 *
 * - DEFAULT_RELAY_URL: the preset relay every flow falls back to.
 * - RelayTransportField: preset transport summary + "advanced" disclosure
 *   (custom relay url, run-your-own link, offline/QR note).
 * - CancelSessionModal: "leaving cancels this session" guard for Back.
 * - ScreenWithTriggerQr / ScanZignerResponse / WaitingForRelay: the
 *   zigner QR-mediated step screens (previously duplicated byte-for-byte
 *   in create.tsx and join.tsx).
 *
 * Presentation only - no protocol logic lives here.
 */

import { useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';

/**
 * Preset relay used when the user doesn't override it under "advanced".
 *
 * HTTPS, not wss: this is a frostd instance, which speaks JSON over HTTP.
 * The previous default was a WebSocket room relay that no longer exists on
 * this path.
 *
 * frostd serves no TLS of its own - it must sit behind a proxy that
 * terminates it. A plain-http relay would expose the login token and the
 * participant list to anyone on the path; it would NOT expose ceremony
 * contents, which are end-to-end encrypted before they leave the device.
 */
export const DEFAULT_RELAY_URL = 'https://relay.zafu.pro';

/** Running your own: ZF's frostd, which is what this speaks. */
export const RELAY_RUNBOOK_URL = 'https://github.com/ZcashFoundation/frost-tools';

/**
 * Transport picker: default is the preset relay with nothing to fill in.
 * "advanced" opens the transport choice - custom relay url (with a link to
 * run your own) or the offline/QR zigner flow.
 */
export const RelayTransportField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center justify-between gap-2 rounded-lg border border-border-soft bg-elev-1 px-3 py-2.5'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='i-ph-broadcast size-3.5 shrink-0 text-fg-muted' />
          <span className='shrink-0 text-xs text-fg-muted'>relay</span>
          <span className='truncate font-mono text-xs'>{value || DEFAULT_RELAY_URL}</span>
        </div>
        <button
          type='button'
          onClick={() => setOpen(o => !o)}
          className='flex shrink-0 items-center gap-1 text-label text-fg-muted transition-colors hover:text-fg-high'
        >
          advanced
          <span
            className={cn('i-ph-caret-down size-3 transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>
      {open && (
        <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
          <p className='text-label text-fg-muted'>
            transport: relay (recommended). every message is encrypted to the signer it is for
            before it leaves this device, so the relay carries ciphertext only - it never sees keys,
            amounts or recipients. only the signers whose relay keys you entered can take part.
          </p>
          <label className='text-label text-fg-muted'>
            your own relay
            <input
              className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-xs focus:border-primary/50 focus:outline-none'
              value={value}
              onChange={e => onChange(e.target.value)}
              placeholder={DEFAULT_RELAY_URL}
            />
          </label>
          <p className='text-label text-fg-muted'>
            run your own:{' '}
            <a
              href={RELAY_RUNBOOK_URL}
              target='_blank'
              rel='noreferrer'
              className='text-zigner-gold hover:underline'
            >
              relay source + guide
            </a>
          </p>
          <p className='text-label text-fg-muted'>
            or keep keys fully offline: the zigner (airgap) flow moves key material over QR codes
            only - the relay still carries the encrypted round messages.
          </p>
        </div>
      )}
    </div>
  );
};

/**
 * Back-guard shown while a live relay session is running. Leaving aborts the
 * session and strands the other signers, so make the user say so explicitly.
 */
export const CancelSessionModal = ({
  open,
  onStay,
  onLeave,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}) => {
  if (!open) {
    return null;
  }
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4'>
      <div className='w-full max-w-sm rounded-lg border border-amber-500/30 bg-elev-1 p-4'>
        <h2 className='text-lg font-medium'>cancel this session?</h2>
        <p className='mt-2 text-xs text-fg-muted'>
          closing cancels this session for everyone - your co-signers will have to start over. are
          you sure?
        </p>
        <div className='mt-4 flex gap-2'>
          <button
            onClick={onStay}
            className='flex-1 rounded-lg border border-border-soft py-2 text-xs transition-colors hover:bg-elev-2'
          >
            stay
          </button>
          <button
            onClick={onLeave}
            className='flex-1 rounded-lg border border-red-500/40 bg-red-500/10 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/20'
          >
            leave anyway
          </button>
        </div>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────
 * Zigner QR-mediated step screens (shared by create + join).
 * ──────────────────────────────────────────────────────────────────── */

interface TriggerProps {
  headline: string;
  body: string;
  triggerJson: string;
  nextLabel: string;
  onNext: () => void;
}

const TRIGGER_UR_TYPE = 'zafu-frost-dkg';

export const ScreenWithTriggerQr = ({
  headline,
  body,
  triggerJson,
  nextLabel,
  onNext,
}: TriggerProps) => {
  const bytes = new TextEncoder().encode(triggerJson);
  return (
    <div className='flex flex-col items-center gap-3'>
      <p className='text-xs text-fg-muted'>{headline}</p>
      <p className='text-label text-fg-muted text-center max-w-xs'>{body}</p>
      <AnimatedQrDisplay data={bytes} urType={TRIGGER_UR_TYPE} size={200} />
      <button
        className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </div>
  );
};

interface ScanProps {
  title: string;
  onScan: (raw: string) => void;
  onCancel: () => void;
}

export const ScanZignerResponse = ({ title, onScan, onCancel }: ScanProps) => (
  <AnimatedQrScanner
    inline
    title={title}
    onComplete={data => onScan(new TextDecoder().decode(data))}
    onClose={onCancel}
  />
);

export const WaitingForRelay = ({
  headline,
  body,
  countdown,
}: {
  headline: string;
  body: string;
  countdown: number | null;
}) => (
  <div className='flex flex-col items-center gap-3'>
    <p className='text-xs text-fg-muted'>{headline}</p>
    <p className='text-label text-fg-muted text-center'>{body}</p>
    <span className='i-ph-circle-notch size-4 animate-spin text-fg-muted' />
    {countdown != null && (
      <span className='text-label text-fg-muted tabular-nums'>{countdown}s</span>
    )}
  </div>
);
