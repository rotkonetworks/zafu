/**
 * The two names a site's page and the service worker share for holding
 * discovery presence (see discovery-presence-port.ts). Kept apart so the
 * content script does not pull in worker code.
 */

/** the port a granted site's page holds open while it is on screen */
export const DISCOVERY_HOLD_PORT = 'zafu-discovery-hold';

/** worker -> content script: this page may hold presence now */
export const DISCOVERY_HOLD_MESSAGE = 'zafu_discovery_hold';

/** worker -> page port: stop holding, do not reconnect (grant gone) */
export const DISCOVERY_HOLD_STOP = 'stop';

/** page -> worker heartbeat, under the worker's 30 s idle limit */
export const DISCOVERY_HOLD_TICK = 'tick';
export const DISCOVERY_HOLD_TICK_MS = 20_000;
