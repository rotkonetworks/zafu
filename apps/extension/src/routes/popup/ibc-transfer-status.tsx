/**
 * Display-only "in transit -> arrived" status line for an IBC transfer.
 *
 * Mounted at the shield/unshield success sites. While mounted it fast-polls the
 * destination (the same idempotent pollOnce the background alarm runs) so
 * arrival shows within a few seconds, and it subscribes to chrome.storage so a
 * transition detected by the service worker (popup closed then reopened) still
 * renders. Purely informational - it never blocks or alters the transfer.
 */

import { useEffect, useState } from 'react';
import {
  pollOnce,
  defaultTrackerDeps,
  IBC_TRANSFER_PREFIX,
  type IbcTransfer,
} from '../../state/ibc-transfer-tracker';
import { uiIbcProbe } from '../../state/ibc-transfer-probes';

/** how often the mounted UI re-probes the destination */
const UI_POLL_MS = 5000;

const readTransfer = async (id: string): Promise<IbcTransfer | undefined> => {
  const stored = await chrome.storage.local.get(IBC_TRANSFER_PREFIX + id);
  return stored[IBC_TRANSFER_PREFIX + id] as IbcTransfer | undefined;
};

/** track one transfer id: fast-poll while mounted + reflect storage changes */
const useTrackedTransfer = (id: string | undefined): IbcTransfer | undefined => {
  const [transfer, setTransfer] = useState<IbcTransfer | undefined>();

  useEffect(() => {
    if (!id) {
      setTransfer(undefined);
      return;
    }
    let cancelled = false;
    const key = IBC_TRANSFER_PREFIX + id;

    void readTransfer(id).then(t => !cancelled && setTransfer(t));

    // reflect transitions written by the SW alarm or another view
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && key in changes) {
        setTransfer(changes[key]?.newValue as IbcTransfer | undefined);
      }
    };
    chrome.storage.onChanged.addListener(onChange);

    // fast-poll the destination while this line is on screen. Note: for an
    // unshield this hits the Noble primary RPC for the burner every few seconds
    // (unlike the deposit scan, which rotates endpoints per burner for privacy).
    // It is one address, only while this success view is mounted, and the SW
    // alarm covers the rest - an acceptable minor tradeoff for a responsive line.
    const tick = async (): Promise<void> => {
      const next = await pollOnce(id, uiIbcProbe, defaultTrackerDeps());
      if (!cancelled) {
        setTransfer(next);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), UI_POLL_MS);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, [id]);

  return transfer;
};

/**
 * Copy shown once we PRESUME a timeout (deadline passed without seeing arrival).
 * It is deliberately hedged: the state is recoverable, so the destination may
 * still confirm arrival. An unshield's ICS20 packet can relay for up to 2 days;
 * a shield's short packet, if it truly timed out, refunds to the Noble source.
 */
const timeoutCopy = (t: IbcTransfer): string =>
  t.direction === 'unshield'
    ? 'still relaying - up to 2 days'
    : 'not seen yet - if it timed out, funds return to your Noble address';

export function IbcTransferStatusLine({ transferId }: { transferId: string | undefined }) {
  const transfer = useTrackedTransfer(transferId);
  if (!transfer) {
    return null;
  }

  if (transfer.status === 'arrived') {
    const secs = transfer.arrivedAt
      ? Math.max(1, Math.round((transfer.arrivedAt - transfer.startedAt) / 1000))
      : undefined;
    return (
      <p className='mt-1 flex items-center gap-1 text-xs text-green-400 lowercase'>
        <span className='i-ph-check-circle h-3.5 w-3.5' />
        arrived{secs !== undefined ? ` (~${secs}s)` : ''}
      </p>
    );
  }

  if (transfer.status === 'timeout') {
    return (
      <p className='mt-1 flex items-center gap-1 text-xs text-fg-muted lowercase'>
        <span className='i-ph-clock-countdown h-3.5 w-3.5' />
        {timeoutCopy(transfer)}
      </p>
    );
  }

  // broadcast: relay in flight
  return (
    <p className='mt-1 flex items-center gap-1 text-xs text-fg-muted lowercase'>
      <span className='i-ph-arrows-left-right h-3.5 w-3.5 animate-pulse' />
      in transit
    </p>
  );
}
