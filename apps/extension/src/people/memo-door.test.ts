/**
 * The memo door's payload: fixed vectors, the size limits of a zcash memo
 * and a penumbra memo's text, and a calm refusal of what it cannot read.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import {
  encodeMemoInvite,
  hasMemoInvite,
  PENUMBRA_MEMO_TEXT_BYTES,
  readMemoInvite,
  ZCASH_MEMO_BYTES,
  type MemoInvite,
} from './memo-door';

const UA = 'u1' + 'q'.repeat(139); // a full unified address, 141 characters
const pair: MemoInvite = {
  kind: 'pair',
  secret: '11'.repeat(32),
  inception: '22'.repeat(32),
  pairKa: '33'.repeat(32),
  name: 'alice',
  address: 'u1short',
  relay: '',
};

// vectors computed independently with python's base64 over the documented layout
describe('memo invite vectors', () => {
  test('a pair invite, byte for byte', () => {
    const line = encodeMemoInvite(pair);
    expect(line).toBe(
      'zafu:m1/AQERERERERERERERERERERERERERERERERERERERERERESIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMFYWxpY2UHdTFzaG9ydAA',
    );
    expect(readMemoInvite(line)).toEqual({ ok: true, invite: pair });
  });

  test('a group invite with its relay, byte for byte', () => {
    const group: MemoInvite = {
      kind: 'group',
      secret: '44'.repeat(32),
      G: '00112233445566778899aabbccddeeff',
      founder: '55'.repeat(32),
      group: 'treasury',
      from: 'bob',
      relay: 'https://relay.example',
    };
    const line = encodeMemoInvite(group);
    expect(line).toBe(
      'zafu:m1/AQJERERERERERERERERERERERERERERERERERERERERERAARIjNEVWZ3iJmqu8zd7v9VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQh0cmVhc3VyeQNib2IVaHR0cHM6Ly9yZWxheS5leGFtcGxl',
    );
    expect(readMemoInvite(line)).toEqual({ ok: true, invite: group });
  });

  test('a group invite is an ordinary door code (#110): it reads back, and a non-code is refused', () => {
    const code: MemoInvite = {
      kind: 'code',
      code: '7-fern-dusk',
      group: 'treasury',
      from: 'bob',
      relay: 'https://relay.example',
    };
    const line = encodeMemoInvite(code, PENUMBRA_MEMO_TEXT_BYTES);
    expect(readMemoInvite(line)).toEqual({ ok: true, invite: code });
    const bad = encodeMemoInvite({ ...code, code: 'not a code' });
    expect(readMemoInvite(bad)).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('found inside a memo that also carries text', () => {
    const memo = `final logo files are up\n${encodeMemoInvite(pair)}`;
    expect(hasMemoInvite(memo)).toBe(true);
    expect(readMemoInvite(memo)).toEqual({ ok: true, invite: pair });
    expect(readMemoInvite('just a memo')).toBeUndefined();
  });
});

describe('memo invite size', () => {
  test('a full address, a 24-character name and a relay fit one zcash memo', () => {
    const line = encodeMemoInvite({
      ...pair,
      name: 'a'.repeat(24),
      address: UA,
      relay: 'https://relay.example.org',
    });
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(ZCASH_MEMO_BYTES);
  });

  test('on penumbra the address stays out (the return address is it) and it fits 432', () => {
    const line = encodeMemoInvite({ ...pair, address: '' }, PENUMBRA_MEMO_TEXT_BYTES);
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(PENUMBRA_MEMO_TEXT_BYTES);
  });

  test('too long is refused, never cut', () => {
    const big = {
      ...pair,
      name: 'a'.repeat(24),
      address: UA,
      relay: `https://${'r'.repeat(48)}.example`,
    };
    expect(() => encodeMemoInvite(big, PENUMBRA_MEMO_TEXT_BYTES)).toThrow(/a memo holds 432/);
    expect(() => encodeMemoInvite({ ...pair, name: 'a'.repeat(25) })).toThrow(/too long/);
    expect(() => encodeMemoInvite({ ...pair, relay: 'ftp://nope' })).toThrow(/url/);
  });
});

describe('what it cannot read', () => {
  test('a newer version is said as such, not guessed', () => {
    const line = encodeMemoInvite(pair);
    // the version byte is the first payload byte: AQ.. is 0x01 0x..; Ag.. is 0x02
    const newer = line.replace('zafu:m1/AQ', 'zafu:m1/Ag');
    expect(readMemoInvite(newer)).toEqual({ ok: false, reason: 'version' });
  });

  test('damaged is unreadable', () => {
    const line = encodeMemoInvite(pair);
    expect(readMemoInvite(line.slice(0, -20))).toEqual({ ok: false, reason: 'unreadable' });
  });
});
