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
 * send's note-tree catch-up comes next, then a classified sync failure.
 */
export const syncNotice = ({
  online,
  catchingUp,
  failure,
}: {
  online: boolean;
  /** a send is catching up the note tree; `left` only from a measured rate */
  catchingUp?: { left?: string };
  failure?: SyncFailure | null;
}): SyncNoticeSpec | undefined =>
  !online
    ? { tone: 'warn', text: OFFLINE_MESSAGE, action: { label: 'retry now', kind: 'retry' } }
    : catchingUp
      ? { tone: 'gold', text: 'catching up the note tree', meta: catchingUp.left }
      : failure
        ? { tone: 'warn', text: failure.message, detail: failure.raw, action: failure.action }
        : undefined;
