import { Code, ConnectError } from '@connectrpc/connect';
import { PenumbraRequestFailure } from '@penumbra-zone/client';
import { UserChoice } from '@repo/storage-chrome/records';
import { ZafuConnection } from '../../content-scripts/message/zafu-connection';
import { ZafuControl } from '../../content-scripts/message/zafu-control';
import { approveSender } from '../../senders/approve';
import { isValidExternalSender, ValidExternalSender } from '../../senders/external';
import { PopupAlreadyOpenError } from '../../popup';
import { throwIfNeedsLogin } from '../../needs-login';
import { sendTab } from '../send/tab';
import { notePanelOpen, wantsSidePanelSync } from '../../side-panel-pref';

// listen for page requests for approval
export const contentScriptConnectListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  // responds with null or an enumerated failure
  respond: (r: null | PenumbraRequestFailure) => void,
): boolean => {
  if (req !== ZafuConnection.Connect) {
    return false;
  }

  if (!isValidExternalSender(sender)) {
    return false;
  }

  // Open the side panel HERE, synchronously, before any await. This connect
  // message rides the dapp's "Connect wallet" click, and transient user
  // activation is a frame-level state that Chrome propagates through the
  // content script's message - so `chrome.sidePanel.open()` counts as
  // gesture-driven ONLY if we call it with nothing awaited before it (both
  // guards above are synchronous). The old path lost the gesture by awaiting
  // window/storage lookups in spawnDetachedPopup first, which is why sidebar
  // mode kept falling back to popups. Opening on connect means the panel is up
  // for the rest of the session (approvals then deliver into it and it stays
  // open via exitApprovalSurface). Best-effort: on failure the popup path still
  // runs. Only in side-panel mode - popup mode stays popup.
  if (wantsSidePanelSync() && sender.tab?.id != null && chrome.sidePanel) {
    const open = chrome.sidePanel.open({ tabId: sender.tab.id });
    notePanelOpen(open);
    void open.catch(() => undefined);
  }

  void handle(sender).then(respond);
  return true;
};

const handle = (sender: ValidExternalSender) =>
  approveSender(sender).then(
    async status => {
      // origin is already known, or popup choice was made
      if (status === UserChoice.Approved) {
        // Gate the provider entry on an unlocked wallet. For a NEW/denied origin
        // approveSender already went through popup(), which calls throwIfNeedsLogin
        // before showing OriginApproval - so by here we are unlocked and this is a
        // no-op (one session-storage read). The gap this closes is the ALREADY
        // approved fast path: a re-connect (e.g. page reload) from a known origin
        // skips that popup, so a locked wallet would Init a provider whose RPCs
        // then fail silently downstream. Surfacing the unlock UI here lets the user
        // unlock and the connection proceed. throwIfNeedsLogin dedups concurrent
        // callers internally, so many tabs reconnecting at once share one window.
        try {
          await throwIfNeedsLogin();
        } catch {
          // throwIfNeedsLogin rejected: the user closed the login window without
          // unlocking (Code.Canceled), or the login window failed to open. Return
          // NeedsLogin (not a silent Init) so the page can instruct the user to
          // log in and retry the connection. (No user-gesture concern here: the
          // login window is a chrome.windows.create, which needs no activation.)
          return PenumbraRequestFailure.NeedsLogin;
        }
        // init only the specific document
        void sendTab(sender, ZafuControl.Init);
        return null; // no failure
      } else {
        // any other choice is a denial
        return PenumbraRequestFailure.Denied;
      }
    },
    async e => {
      if (e instanceof PopupAlreadyOpenError) {
        // A duplicate/racing connect while an approval is already open. The
        // existing window was surfaced; do not deny or delay - return null so
        // the page keeps waiting for the in-flight decision (which Inits on
        // approval). null is not forwarded to the page as a failure.
        return null;
      } else if (
        e instanceof ConnectError &&
        (e.code === Code.Unauthenticated || e.code === Code.Canceled)
      ) {
        // The wallet is locked and the user did not unlock: the OriginApproval
        // popup path calls throwIfNeedsLogin first, which rejects Code.Canceled
        // when the login window is closed without unlocking (spawnLoginPopup) -
        // needs-login is the only Code.Canceled source reachable here. Surface
        // NeedsLogin so the page can instruct the user to log in and retry,
        // instead of the obfuscated-delay Denied below. (Code.Unauthenticated is
        // kept as a defensive alias; nothing currently throws it on this path.)
        return PenumbraRequestFailure.NeedsLogin;
      } else {
        console.warn('Connection request listener failed', e);
        // user may not have seen a popup, and something strange is happening.
        // obfuscate this rejection with a random delay 2-12 secs
        const DELAY = 2_000 + Math.random() * 10_000;
        await new Promise<void>(resolve => setTimeout(() => resolve(), DELAY));
        return PenumbraRequestFailure.Denied;
      }
    },
  );
