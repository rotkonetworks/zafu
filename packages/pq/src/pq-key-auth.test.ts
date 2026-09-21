import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { pqKeyAuthMessage, PQ_KEY_AUTH_DOMAIN } from './pq-key-auth';

// The canonical encoder the wallet signs and the dapp SDK verifies (P1). The
// sign/verify round-trip lives in @zafu/zid (which has @noble/curves); here we
// pin the encoding itself: determinism, domain separation, and unambiguous
// length-prefixed framing so no two distinct field tuples ever collide.
describe('pqKeyAuthMessage encoding', () => {
  const suite = 'xwing-v1';
  const origin = 'https://app.example.com';
  const epoch = 42;
  const pqPubkey = randomBytes(1216); // X-Wing pk size

  it('is deterministic', () => {
    expect(pqKeyAuthMessage(suite, origin, epoch, pqPubkey)).toEqual(
      pqKeyAuthMessage(suite, origin, epoch, pqPubkey),
    );
  });

  it('is domain-prefixed (first field is the version tag)', () => {
    const a = pqKeyAuthMessage(suite, origin, epoch, pqPubkey);
    // 4-byte BE length prefix, then the domain tag bytes.
    expect(new TextDecoder().decode(a.slice(4, 4 + PQ_KEY_AUTH_DOMAIN.length))).toBe(
      PQ_KEY_AUTH_DOMAIN,
    );
  });

  it('changes if ANY bound field changes', () => {
    const base = pqKeyAuthMessage(suite, origin, epoch, pqPubkey);
    expect(pqKeyAuthMessage('xwing-v2', origin, epoch, pqPubkey)).not.toEqual(base);
    expect(pqKeyAuthMessage(suite, 'https://evil.example', epoch, pqPubkey)).not.toEqual(base);
    expect(pqKeyAuthMessage(suite, origin, epoch + 1, pqPubkey)).not.toEqual(base);
    expect(pqKeyAuthMessage(suite, origin, epoch, randomBytes(1216))).not.toEqual(base);
  });

  it('length-prefix framing prevents field-boundary collisions', () => {
    // a separatorless concat would collide these; length-prefixing must not.
    expect(pqKeyAuthMessage('ab', 'c', epoch, pqPubkey)).not.toEqual(
      pqKeyAuthMessage('a', 'bc', epoch, pqPubkey),
    );
  });
});
