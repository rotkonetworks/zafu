import { useNavigate } from 'react-router-dom';
import { SyncStatus, type SyncStatusProps } from '../zcash/sync-status';
import { syncNotice } from '../zcash/sync-notice';
import type { SyncFailure } from '../../state/sync-failure';
import { useOnline } from '../../hooks/use-online';
import { catchUpLeft, useCatchUp } from '../../state/witness-rebuild';
import { useTxOps } from '../../tx-ops/use-tx-ops';
import { PopupPath } from '../../routes/popup/paths';

/**
 * The strip's own subscriptions (network, a send's note-tree catch-up, the
 * tracker) live here, so a change re-renders the strip and not the screen.
 * A catch-up counts only on a network that keeps witnesses, and only
 * while a send of that network is still pending.
 */
export const SyncStrip = ({
  network,
  rebuilds,
  synced,
  failure,
  onRetry,
  notice,
  ...sync
}: SyncStatusProps & {
  network: 'zcash' | 'penumbra';
  rebuilds?: boolean;
  synced: boolean;
  failure: SyncFailure | null;
  onRetry: () => void;
}) => {
  const navigate = useNavigate();
  const online = useOnline();
  const sending = useTxOps().some(op => op.network === network && op.status === 'pending');
  const catchUp = useCatchUp();
  const spec = syncNotice({
    online,
    catchingUp: rebuilds && sending && catchUp ? { left: catchUpLeft(catchUp) } : undefined,
    failure,
  });
  if (synced && !spec && !notice) {
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
        notice ??
        (spec && {
          ...spec,
          action: spec.action && { label: spec.action.label, onClick: run[spec.action.kind] },
        })
      }
    />
  );
};
