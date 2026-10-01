/**
 * The one consent prompt the egress guard raises itself: a host no destination
 * owns, reached from the service worker while the Keplr-compatible site
 * surface is on (a dapp's `sendTx` to the rpc it advertised). Ask once per host;
 * the answer lands in the ledger as a per-host decision, and a window closed
 * undecided refuses this request without recording a denial.
 */

import { hostOf } from './destination';
import { claimPrompt } from './ledger';
import { requestDestinationConsent } from './prompt';

export const askAboutUnknownHost = async (url: string): Promise<boolean> => {
  const host = hostOf(url);
  if (!host || !(await claimPrompt(host, 'other'))) {
    return false;
  }
  return (await requestDestinationConsent(host, 'other')) === 'approved';
};
