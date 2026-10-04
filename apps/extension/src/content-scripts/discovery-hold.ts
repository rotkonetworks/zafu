/**
 * Page side of discovery presence: once zafu says this page may hold presence
 * (the site asked for friends, or the person turned "friends can find you
 * here" on while it was open), keep one port to the worker for as long as the
 * page is open, with a heartbeat that keeps the worker's 5-minute beacon
 * going. The port dies with the page, and the beacon with it. Nothing here
 * runs on a site that never asked.
 */

import {
  DISCOVERY_HOLD_MESSAGE,
  DISCOVERY_HOLD_PORT,
  DISCOVERY_HOLD_STOP,
  DISCOVERY_HOLD_TICK,
  DISCOVERY_HOLD_TICK_MS,
} from '../discovery-hold-names';

let held: chrome.runtime.Port | undefined;
let retries = 0;

const connect = (): void => {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: DISCOVERY_HOLD_PORT });
  } catch {
    return; // extension reloaded under this page: nothing to hold
  }
  held = port;
  let stopped = false;
  const timer = setInterval(() => {
    try {
      port.postMessage(DISCOVERY_HOLD_TICK);
    } catch {
      clearInterval(timer);
    }
  }, DISCOVERY_HOLD_TICK_MS);
  port.onMessage.addListener(m => {
    if (m === DISCOVERY_HOLD_STOP) {
      stopped = true;
    } else {
      retries = 0; // the worker took the hold
    }
  });
  port.onDisconnect.addListener(() => {
    clearInterval(timer);
    held = undefined;
    // a restarted worker drops every port: ask again (it re-checks the grant),
    // but never after it said stop, and never in a loop
    if (!stopped && retries++ < 3) {
      setTimeout(connect, 2_000);
    }
  });
};

chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  if (
    sender.id === chrome.runtime.id &&
    (msg as { type?: unknown } | null)?.type === DISCOVERY_HOLD_MESSAGE &&
    !held
  ) {
    retries = 0;
    connect();
  }
  return false;
});

// a page that leaves (or goes into the back/forward cache) is not on the site
// any more: let go, so the beacon stops with it
window.addEventListener('pagehide', () => {
  held?.disconnect();
  held = undefined;
});
