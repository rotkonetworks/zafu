/**
 * The decision table the whole capability surface reduces to. Pinned here
 * because two of its rows are the ones that bite: `unset` must ask (a fresh
 * install is not an opt-out), and `disabled` must refuse an origin that still
 * holds a grant (turning a capability off is a revocation, not a hint).
 */
import { describe, expect, it } from 'vitest';

import {
  withDefault,
  decideCapabilityUse,
  isOptinPending,
  modeFromOptin,
  parseCapabilityMode,
} from './capability-decision';

describe('parseCapabilityMode', () => {
  it('accepts only the two decisions storage is allowed to hold', () => {
    expect(parseCapabilityMode('enabled')).toBe('enabled');
    expect(parseCapabilityMode('disabled')).toBe('disabled');
  });

  it('treats absence and any other value as undecided', () => {
    expect(parseCapabilityMode(undefined)).toBe('unset');
    expect(parseCapabilityMode(null)).toBe('unset');
    expect(parseCapabilityMode('unset')).toBe('unset');
    expect(parseCapabilityMode(true)).toBe('unset');
    expect(parseCapabilityMode({ mode: 'enabled' })).toBe('unset');
  });
});

describe('modeFromOptin / isOptinPending', () => {
  it('maps the answer onto a sticky decision', () => {
    expect(modeFromOptin(true)).toBe('enabled');
    expect(modeFromOptin(false)).toBe('disabled');
  });

  it('only prompts while undecided', () => {
    expect(isOptinPending('unset')).toBe(true);
    expect(isOptinPending('enabled')).toBe(false);
    expect(isOptinPending('disabled')).toBe(false);
  });
});

describe('decideCapabilityUse', () => {
  const decide = (mode: 'unset' | 'enabled' | 'disabled', grantedToOrigin: boolean) =>
    decideCapabilityUse({ mode, grantedToOrigin });

  it('refuses every origin when the capability is off, even a granted one', () => {
    expect(decide('disabled', true)).toEqual({ action: 'refuse' });
    expect(decide('disabled', false)).toEqual({ action: 'refuse' });
  });

  it('asks the global question while undecided, before any per-site state', () => {
    expect(decide('unset', false)).toEqual({ action: 'prompt', prompt: 'opt-in' });
    // a grant that predates the switch does not answer the global question
    expect(decide('unset', true)).toEqual({ action: 'prompt', prompt: 'opt-in' });
  });

  it('allows a granted origin once enabled', () => {
    expect(decide('enabled', true)).toEqual({ action: 'allow' });
  });

  it('falls back to the per-site prompt once enabled but ungranted', () => {
    expect(decide('enabled', false)).toEqual({ action: 'prompt', prompt: 'origin-consent' });
  });
});

describe('withDefault', () => {
  it('reads an unanswered default-on capability as on, and leaves the rest alone', () => {
    expect(withDefault('encrypt', 'unset')).toBe('enabled');
    expect(withDefault('encrypt', 'disabled')).toBe('disabled');
    expect(withDefault('frost', 'unset')).toBe('unset');
  });
});
