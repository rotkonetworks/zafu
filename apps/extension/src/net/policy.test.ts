/**
 * The decision table, expanded rather than generated: every row is written out
 * with its expectation so a change in `decideEgress` has to disagree with a
 * literal a reviewer can read, instead of with a helper that mirrors the
 * implementation.
 *
 * Dimensions: local(2) x trusted(2) x compat(2) x destination(4) = 32 rows.
 */
import { describe, expect, it } from 'vitest';
import { decideEgress, type EgressDecision, type EgressFacts } from './policy';
import type { DestinationState } from './destination';

const allow: EgressDecision = { action: 'allow' };
const refuseBlocked: EgressDecision = { action: 'refuse', reason: 'blocked' };
const refuseFeature: EgressDecision = { action: 'refuse', reason: 'feature-disabled' };
const prompt: EgressDecision = { action: 'prompt' };

describe('decideEgress', () => {
  const rows: [EgressFacts, EgressDecision][] = [
    // ── local device: never gated, in any other configuration ──
    [{ local: true, trusted: false, adhocConsentAvailable: false, destination: undefined }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: false, destination: 'pending' }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: false, destination: 'allowed' }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: false, destination: 'blocked' }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: true, destination: undefined }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: true, destination: 'pending' }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: true, destination: 'allowed' }, allow],
    [{ local: true, trusted: false, adhocConsentAvailable: true, destination: 'blocked' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: false, destination: undefined }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: false, destination: 'pending' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: false, destination: 'allowed' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: false, destination: 'blocked' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: true, destination: undefined }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: true, destination: 'pending' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: true, destination: 'allowed' }, allow],
    [{ local: true, trusted: true, adhocConsentAvailable: true, destination: 'blocked' }, allow],

    // ── an explicit refusal is sticky, before anything else can allow it ──
    [
      { local: false, trusted: false, adhocConsentAvailable: false, destination: 'blocked' },
      refuseBlocked,
    ],
    [
      { local: false, trusted: false, adhocConsentAvailable: true, destination: 'blocked' },
      refuseBlocked,
    ],
    [
      { local: false, trusted: true, adhocConsentAvailable: false, destination: 'blocked' },
      refuseBlocked,
    ],
    [
      { local: false, trusted: true, adhocConsentAvailable: true, destination: 'blocked' },
      refuseBlocked,
    ],

    // ── an explicit approval opens the host regardless of trust or compat ──
    [{ local: false, trusted: false, adhocConsentAvailable: false, destination: 'allowed' }, allow],
    [{ local: false, trusted: false, adhocConsentAvailable: true, destination: 'allowed' }, allow],
    [{ local: false, trusted: true, adhocConsentAvailable: false, destination: 'allowed' }, allow],
    [{ local: false, trusted: true, adhocConsentAvailable: true, destination: 'allowed' }, allow],

    // ── trusted (zafu's own config, or user-configured): no prompt, ever.
    //    This is the row that keeps a fresh install from being interrogated
    //    about its own endpoints, and the one that makes "user typed the RPC
    //    url themselves" an approval. ──
    [{ local: false, trusted: true, adhocConsentAvailable: false, destination: undefined }, allow],
    [{ local: false, trusted: true, adhocConsentAvailable: true, destination: undefined }, allow],
    [{ local: false, trusted: true, adhocConsentAvailable: false, destination: 'pending' }, allow],
    [{ local: false, trusted: true, adhocConsentAvailable: true, destination: 'pending' }, allow],

    // ── untrusted + compat open: the one case that asks the user ──
    [{ local: false, trusted: false, adhocConsentAvailable: true, destination: undefined }, prompt],
    [{ local: false, trusted: false, adhocConsentAvailable: true, destination: 'pending' }, prompt],

    // ── untrusted + compat closed: refuse with a reason the caller can surface.
    //    Nothing should reach this state; when it does, a refusal the user can
    //    act on beats a prompt about a host they never asked for. ──
    [
      { local: false, trusted: false, adhocConsentAvailable: false, destination: undefined },
      refuseFeature,
    ],
    [
      { local: false, trusted: false, adhocConsentAvailable: false, destination: 'pending' },
      refuseFeature,
    ],
  ];

  it.each(rows)('local=%o trusted=%o compat=%o dest=%o', (facts, expected) => {
    expect(decideEgress(facts)).toEqual(expected);
  });

  it('covers every combination of the four dimensions', () => {
    const destinations: (DestinationState | undefined)[] = [
      undefined,
      'pending',
      'allowed',
      'blocked',
    ];
    const seen = new Set<string>();
    for (const raw of rows) {
      const f = raw[0];
      seen.add(`${f.local}|${f.trusted}|${f.adhocConsentAvailable}|${f.destination ?? 'none'}`);
    }
    for (const local of [false, true]) {
      for (const trusted of [false, true]) {
        for (const compat of [false, true]) {
          for (const destination of destinations) {
            expect(seen.has(`${local}|${trusted}|${compat}|${destination ?? 'none'}`)).toBe(true);
          }
        }
      }
    }
    expect(rows).toHaveLength(32);
  });

  it('refuses an untrusted host when compat is closed but has no prompt for it', () => {
    // Regression guard for the reported prompt storm: a wallet that never
    // enabled the transparent-chain surface must not be able to reach an
    // outside-in host at all, and must not ask about one.
    const decision = decideEgress({
      local: false,
      trusted: false,
      adhocConsentAvailable: false,
      destination: undefined,
    });
    expect(decision.action).toBe('refuse');
    expect(decision).toEqual(refuseFeature);
  });
});
