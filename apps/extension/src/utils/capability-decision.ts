import type { Capability } from '@repo/storage-chrome/capabilities';

/**
 * The site-facing gate for every capability, as a pure function of explicit
 * state. No chrome.*, no storage, no prompts: the caller (the message listener
 * that owns the capability gate) supplies the state and executes the decision.
 *
 * Two orthogonal questions, deliberately separated:
 *
 *   1. Does zafu participate in this capability at all? (`mode`) - a global,
 *      per-capability switch the user sets once, first time a site asks.
 *   2. Has *this site* been granted the capability? (`grantedToOrigin`) - the
 *      existing per-origin consent, unchanged.
 *
 * `unset` is the state of a fresh install and is not the same as `disabled`:
 * it means "ask the user once", not "refuse".
 */
export type CapabilityMode = 'unset' | 'enabled' | 'disabled';

/**
 * `origin-consent` is the long-standing per-site prompt; `opt-in` is the
 * one-time "does zafu do this at all" question. They are different questions
 * with different copy and different persistence, so they are distinct actions
 * rather than one "prompt".
 */
export type CapabilityDecision =
  | { action: 'allow' }
  | { action: 'refuse' }
  | { action: 'prompt'; prompt: 'opt-in' | 'origin-consent' };

export interface CapabilityState {
  mode: CapabilityMode;
  grantedToOrigin: boolean;
}

/**
 * Total function: given the state, the gate's answer is fixed. A disabled
 * capability refuses even an origin that holds a stale grant, so turning a
 * capability off in settings revokes access immediately everywhere.
 */
export const decideCapabilityUse = (state: CapabilityState): CapabilityDecision => {
  if (state.mode === 'disabled') {
    return { action: 'refuse' };
  }
  if (state.mode === 'unset') {
    return { action: 'prompt', prompt: 'opt-in' };
  }
  return state.grantedToOrigin
    ? { action: 'allow' }
    : { action: 'prompt', prompt: 'origin-consent' };
};

/**
 * Capabilities zafu does unless turned off: no one-time opt-in. `encrypt` is
 * one: its keys are derived per site, so a site can only open what was sealed
 * to its own identity there, never another site's or the wallet's. Each site
 * still asks its own consent once.
 */
export const DEFAULT_ON: ReadonlySet<Capability> = new Set<Capability>(['encrypt']);

/** A capability's mode once its default is applied: unset means on for these. */
export const withDefault = (capability: Capability, mode: CapabilityMode): CapabilityMode =>
  mode === 'unset' && DEFAULT_ON.has(capability) ? 'enabled' : mode;

/** Storage holds only decisions; anything else (including absent) is `unset`. */
export const parseCapabilityMode = (raw: unknown): CapabilityMode =>
  raw === 'enabled' || raw === 'disabled' ? raw : 'unset';

/** The answer to the opt-in prompt is the mode; denial is sticky. */
export const modeFromOptin = (approved: boolean): CapabilityMode =>
  approved ? 'enabled' : 'disabled';

/** A capability is only promptable while still undecided. */
export const isOptinPending = (mode: CapabilityMode): boolean => mode === 'unset';

/**
 * Capabilities the user explicitly turned off, for the settings screen.
 * `Partial` because absent means unset.
 */
export type CapabilityModeMap = Partial<Record<Capability, CapabilityMode>>;
