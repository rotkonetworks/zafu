/**
 * Egress guard for realms without `chrome.storage`: the offscreen document,
 * web workers, and content scripts. Import FIRST in the entry.
 *
 * Workers and the offscreen document receive the compiled table from a
 * storage realm over the channel and fail closed until it arrives. A content
 * script (an extension context running inside a web page) refuses everything:
 * zafu never talks to anyone on a page's behalf from there.
 */

import { installEgress } from './egress';

const inPage = typeof document !== 'undefined' && location.protocol !== 'chrome-extension:';
const inOffscreen = typeof document !== 'undefined' && !inPage;

installEgress(inPage ? 'content-script' : inOffscreen ? 'offscreen' : 'worker');
