import {
  OFFLINE_MESSAGE,
  type SyncFailure,
  type SyncFailureAction,
} from '../../state/sync-failure';

export interface SyncNoticeSpec {
  tone: 'warn' | 'gold';
  text: string;
  meta?: string;
  detail?: string;
  action?: SyncFailureAction;
}

/**
 * The one notice the sync strip shows, from what zafu already knows: no
 * network beats everything (nothing else can be true about the node), a
 * witness rebuild in progress comes next, then a classified sync failure.
 */
export const syncNotice = ({
  online,
  rebuildLeft,
  failure,
}: {
  online: boolean;
  rebuildLeft?: string;
  failure?: SyncFailure | null;
}): SyncNoticeSpec | undefined =>
  !online
    ? { tone: 'warn', text: OFFLINE_MESSAGE, action: { label: 'retry now', kind: 'retry' } }
    : rebuildLeft
      ? { tone: 'gold', text: 'witness corrupt - rebuilding', meta: rebuildLeft }
      : failure
        ? { tone: 'warn', text: failure.message, detail: failure.raw, action: failure.action }
        : undefined;
