import { CRSessionManager } from '@penumbra-zone/transport-chrome/session-manager';
import { removeOriginRecord } from '@repo/storage-chrome/origin';
import { ZafuControl } from '../content-scripts/message/zafu-control';
import { sendTabs } from '../message/send/tab';

/**
 * Request deletion of the origin's permission record, and ask the session
 * manager to immediately kill sessions associated with the origin.
 *
 * The session manager returns a list of senders associated with killed
 * sessions. A `ZafuConnection.End` message is sent to the content scripts in
 * those senders.
 */
export const revokeOrigin = (targetOrigin: string) => {
  void removeOriginRecord(targetOrigin);
  const killedSenders = CRSessionManager.killOrigin(targetOrigin);

  void Promise.allSettled(
    // The sessions are already dead. But they'll assume disconnect is just chrome
    // flakiness, and try to wake up for new requests. The killed sessions should
    // fail to reconnect, but they will keep trying.
    //
    // This informs the content scripts they are actually disconnected, so they
    // can clean up.
    sendTabs(killedSenders, ZafuControl.End),
  ).then(results => {
    // A tab that can't be reached ("Receiving end does not exist", no
    // response) was closed, navigated away, or holds a content script orphaned
    // by an earlier extension update. None of those can reconnect: the
    // permission record is gone and an orphan has no runtime. So there is
    // nothing left to end.
    //
    // This used to chrome.runtime.reload() the whole extension instead, which
    // dropped every other site's connection, invalidated every open dapp tab
    // ("Extension context invalidated") and rebuilt the penumbra wallet from
    // scratch - all to tidy up one tab that was already gone.
    const unreachable = results.filter(r => r.status === 'rejected');
    if (unreachable.length) {
      console.debug(
        `revoke ${targetOrigin}: ${unreachable.length} tab(s) already gone`,
        unreachable.map(r => r.reason),
      );
    }
  });
};
