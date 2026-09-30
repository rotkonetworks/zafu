/**
 * The UI-facing side of the egress policy: read what zafu talks to, and ask to
 * turn an optional destination on at the moment a feature needs it.
 *
 * A feature that needs an optional destination (zcash.me, the swap service,
 * the chat relay, voting, ...) calls {@link requestEgressOptIn} with its
 * destination id before its first request. When the destination is already on
 * it resolves true at once. Otherwise the registered asker decides - the ask
 * sheet, installed by the UI with {@link setEgressAsker} - and a yes is stored
 * as the destination's opt-in. With no asker installed the answer is no:
 * nothing optional is ever contacted by default.
 */

import {
  describeEgress,
  EGRESS_INPUT_KEYS,
  type DestinationView,
  type EgressInputs,
} from './egress-policy';
import { refreshEgress } from './egress';
import { hostOf } from './destination';
import { grantHosts, setDestinationOptIn } from './ledger';

export const readEgressInputs = async (): Promise<EgressInputs> =>
  (await chrome.storage.local.get([...EGRESS_INPUT_KEYS])) as EgressInputs;

/** Every destination, its hosts, and whether it is on and why. */
export const readEgressView = async (): Promise<DestinationView[]> =>
  describeEgress(await readEgressInputs());

export type EgressAsker = (destination: DestinationView) => Promise<boolean>;

let asker: EgressAsker = () => Promise.resolve(false);

/** Install the ask sheet. Returns the uninstall. */
export const setEgressAsker = (next: EgressAsker): (() => void) => {
  asker = next;
  return () => {
    if (asker === next) {
      asker = () => Promise.resolve(false);
    }
  };
};

/**
 * Resolve true when `destination` may be contacted, asking the user if it is
 * off. A destination the user blocked is not asked about again - unblocking
 * is a settings decision, not a prompt.
 */
export const requestEgressOptIn = async (destination: string): Promise<boolean> => {
  const view = (await readEgressView()).find(d => d.id === destination);
  if (!view) {
    return false;
  }
  if (view.on) {
    return true;
  }
  if (view.why === 'you-blocked' || view.why === 'network-off' || !(await asker(view))) {
    return false;
  }
  await setDestinationOptIn(destination, 'allowed');
  await refreshEgress();
  return true;
};

/**
 * Allow the hosts an opted-in destination names at run time - the vote and PIR
 * servers a voting config lists. A no-op while the destination is off, so a
 * config can never widen what the user has not turned on.
 */
export const grantDestinationHosts = async (destination: string, urls: string[]): Promise<void> => {
  const view = (await readEgressView()).find(d => d.id === destination);
  if (!view?.on) {
    return;
  }
  const hosts = urls.flatMap(u => hostOf(u) ?? []);
  await grantHosts(hosts, `named by ${view.label}`, view.purpose);
  await refreshEgress();
};
