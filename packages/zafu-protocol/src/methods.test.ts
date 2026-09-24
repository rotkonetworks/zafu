import { describe, it, expect } from 'vitest';
import { ZAFU_PROTOCOL_VERSION } from './version';
import {
  ZAFU_V1_METHODS,
  isZafuError,
  type ZafuMethod,
  type ZafuRequest,
  type ZafuResponse,
  type ZafuDiscoveredContact,
} from './methods';

describe('zafu protocol version', () => {
  it('is a positive integer major', () => {
    expect(Number.isInteger(ZAFU_PROTOCOL_VERSION)).toBe(true);
    expect(ZAFU_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('ZAFU_V1_METHODS', () => {
  it('has no duplicates', () => {
    expect(new Set(ZAFU_V1_METHODS).size).toBe(ZAFU_V1_METHODS.length);
  });

  it('every entry is ping or a zafu_-prefixed method', () => {
    for (const m of ZAFU_V1_METHODS) {
      expect(m === 'ping' || m.startsWith('zafu_')).toBe(true);
    }
  });

  it('excludes the fund-safety FROST surface and the unimplemented invite stub', () => {
    const excluded = [
      'zafu_frost_create',
      'zafu_frost_join',
      'zafu_frost_sign',
      'zafu_frost_sign_orchard',
      'zafu_dkg_join',
      'zafu_delete_multisig',
      'zafu_send_invite',
    ];
    for (const m of excluded) {
      expect(ZAFU_V1_METHODS as readonly string[]).not.toContain(m);
    }
  });

  it('is the exact v1 surface (guards accidental additions/removals)', () => {
    // A change here is intentional and should come with a version bump if it
    // alters the wire surface. Kept sorted for a stable diff.
    const expected: ZafuMethod[] = [
      'ping',
      'zafu_decrypt',
      'zafu_discover_contacts',
      'zafu_encrypt',
      'zafu_get_fresh_chain_address',
      'zafu_open_shield',
      'zafu_pick_contacts',
      'zafu_request_capability',
      'zafu_sign',
      'zafu_zid_pubkey',
    ];
    expect([...ZAFU_V1_METHODS].sort()).toEqual(expected.sort());
  });
});

describe('isZafuError', () => {
  it('narrows the error shape', () => {
    expect(isZafuError({ error: 'denied' })).toBe(true);
    expect(isZafuError({ pubkey: 'ab12' })).toBe(false);
    expect(isZafuError({ success: false, error: 'x' })).toBe(true);
    expect(isZafuError(null)).toBe(false);
    expect(isZafuError({ error: 42 })).toBe(false);
  });
});

describe('zafu_discover_contacts wire shapes', () => {
  it('the request carries exactly { type, appScope }', () => {
    const req: ZafuRequest<'zafu_discover_contacts'> = {
      type: 'zafu_discover_contacts',
      appScope: 'https://poker.zk.bot',
    };
    expect(JSON.parse(JSON.stringify(req))).toEqual({
      type: 'zafu_discover_contacts',
      appScope: 'https://poker.zk.bot',
    });
  });

  it('a success reply is a present intersection of handle/sessionPubHex/caps', () => {
    const contact: ZafuDiscoveredContact = {
      handle: 'a'.repeat(64),
      sessionPubHex: 'b'.repeat(64),
      caps: 3,
    };
    const res: ZafuResponse<'zafu_discover_contacts'> = { contacts: [contact] };
    // round-trips unchanged and is NOT the error shape
    expect(JSON.parse(JSON.stringify(res))).toEqual({ contacts: [contact] });
    expect(isZafuError(res)).toBe(false);
  });

  it('a refusal is the standard error shape and narrows via isZafuError', () => {
    const refusal: ZafuResponse<'zafu_discover_contacts'> = {
      error: 'contact discovery is not available',
      code: 'not_available',
    };
    expect(isZafuError(refusal)).toBe(true);
  });
});
