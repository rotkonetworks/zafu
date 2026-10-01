import { useNavigate } from 'react-router-dom';
import { SyncStatus, type SyncStatusProps } from '../zcash/sync-status';
import { syncNotice } from '../zcash/sync-notice';
import type { SyncFailure } from '../../state/sync-failure';
import { useOnline } from '../../hooks/use-online';
import { useRebuildLeft, useRebuildSince } from '../../state/witness-rebuild';
import { useTxOps } from '../../tx-ops/use-tx-ops';
import { PopupPath } from '../../routes/popup/paths';

/**
 * The strip's own subscriptions (network, a running witness rebuild, the
 * tracker) live here, so a change re-renders the strip and not the screen.
 * A rebuild counts only on a network that rebuilds witnesses, and only
 * while a send of that network is still pending.
 */
export const SyncStrip = ({
  network,
  rebuilds,
  synced,
  failure,
  onRetry,
  ...sync
}: Omit<SyncStatusProps, 'notice'> & {
  network: 'zcash' | 'penumbra';
  rebuilds?: boolean;
  synced: boolean;
  failure: SyncFailure | null;
  onRetry: () => void;
}) => {
  const navigate = useNavigate();
  const online = useOnline();
  const sending = useTxOps().some(op => op.network === network && op.status === 'pending');
  const rebuildLeft = useRebuildLeft(useRebuildSince());
  const spec = syncNotice({
    online,
    rebuildLeft: rebuilds && sending ? rebuildLeft : undefined,
    failure,
  });
  if (synced && !spec) {
    return null;
  }
  const run = {
    settings: () => navigate(`${PopupPath.SETTINGS_NETWORKS}?network=${network}`),
    reload: () => window.location.reload(),
    retry: onRetry,
  };
  return (
    <SyncStatus
      {...sync}
      notice={
        spec && {
          ...spec,
          action: spec.action && { label: spec.action.label, onClick: run[spec.action.kind] },
        }
      }
    />
  );
};
