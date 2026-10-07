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
import { setDestinationOptIn } from './ledger';

export const readEgressInputs = async (): Promise<EgressInputs> =>
  (await chrome.storage.local.get([...EGRESS_INPUT_KEYS])) as EgressInputs;

/** Every destination, its hosts, and whether it is on and why. */
export const readEgressView = async (): Promise<DestinationView[]> =>
  describeEgress(await readEgressInputs());

export type EgressAsker = (destinations: DestinationView[]) => Promise<boolean>;

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

const ask = async (ids: readonly string[]): Promise<boolean> => {
  const views = (await readEgressView()).filter(d => ids.includes(d.id));
  const off = views.filter(d => !d.on);
  // a destination the user blocked is not asked about again - unblocking is a settings decision
  const askable = off.filter(d => d.why !== 'you-blocked' && d.why !== 'network-off');
  if (views.length < ids.length) {
    return false;
  }
  if (!off.length) {
    return true;
  }
  if (!askable.length || !(await asker(askable))) {
    return false;
  }
  for (const d of askable) {
    await setDestinationOptIn(d.id, 'allowed');
  }
  await refreshEgress();
  return askable.length === off.length;
};

/** one sheet at a time: a later ask waits for the open one, then sees its answer */
let asking: Promise<unknown> = Promise.resolve();

/**
 * Resolve true when every one of `destinations` may be contacted, asking once,
 * in one sheet, about those that are off. A feature that needs several (a swap
 * asks every route it prices) asks for them together, so the person answers
 * once.
 */
export const requestEgressOptIn = (destinations: string | readonly string[]): Promise<boolean> => {
  const turn = asking.then(() =>
    ask(typeof destinations === 'string' ? [destinations] : destinations),
  );
  asking = turn.catch(() => undefined);
  return turn;
};
