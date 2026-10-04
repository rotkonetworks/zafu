import { describe, expect, it } from 'vitest';
import { classifySyncFailure, OFFLINE_MESSAGE } from '../../state/sync-failure';
import { syncNotice } from './sync-notice';

const nodeDown = classifySyncFailure('connection refused');

describe('syncNotice', () => {
  it('says offline first, whatever else is failing', () => {
    const n = syncNotice({
      online: false,
      catchingUp: { left: 'about 2 min left' },
      failure: nodeDown,
    });
    expect(n).toMatchObject({ tone: 'warn', text: OFFLINE_MESSAGE, action: { kind: 'retry' } });
  });

  it('shows a send note-tree catch-up over a sync failure', () => {
    const n = syncNotice({
      online: true,
      catchingUp: { left: 'about 2 min left' },
      failure: nodeDown,
    });
    expect(n).toMatchObject({ tone: 'gold', meta: 'about 2 min left' });
  });

  it('turns a node that is not answering into the choose line', () => {
    const n = syncNotice({ online: true, failure: nodeDown });
    expect(n).toMatchObject({
      tone: 'warn',
      text: "the node isn't answering · zafu keeps trying",
      detail: 'connection refused',
      action: { label: 'choose', kind: 'settings' },
    });
  });

  it('is quiet when nothing is wrong', () => {
    expect(syncNotice({ online: true, failure: null })).toBeUndefined();
  });
});
