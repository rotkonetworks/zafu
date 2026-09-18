import { describe, it, expect, vi, beforeEach } from 'vitest';

import { detect, requireWallet, sign, signBytes, zidPubkey, encryptFor, decryptFrom } from './messaging';
import { ZafuError } from './errors';

// mock the transport + detection so we can drive wallet responses directly.
// vi.hoisted: these are referenced by the hoisted vi.mock factories.
const { request, detectZafu } = vi.hoisted(() => ({ request: vi.fn(), detectZafu: vi.fn() }));
vi.mock('./transport', () => ({
  createExtensionTransport: () => ({ request, isAvailable: async () => true }),
}));
vi.mock('./provider', () => ({ detectZafu }));

const handle = { origin: 'chrome-extension://abc/', provider: {} };

beforeEach(() => {
  request.mockReset();
  detectZafu.mockReset();
});

describe('detect()', () => {
  it('reports not-installed when no wallet is found', async () => {
    detectZafu.mockResolvedValue(null);
    expect(await detect()).toEqual({ installed: false });
  });

  it('negotiates the protocol version from ping', async () => {
    request.mockResolvedValue({ zafu: true, version: '28.1.0', protocolVersion: 1, protocolVersions: [1] });
    const d = await detect(handle);
    expect(d.installed).toBe(true);
    expect(d.walletVersion).toBe('28.1.0');
    expect(d.compatible).toBe(true);
  });

  it('marks incompatible when the wallet shares no protocol major', async () => {
    request.mockResolvedValue({ zafu: true, version: '99', protocolVersion: 2, protocolVersions: [2] });
    const d = await detect(handle);
    expect(d.installed).toBe(true);
    expect(d.compatible).toBe(false);
  });

  it('never throws on transport failure', async () => {
    request.mockRejectedValue(new Error('boom'));
    expect(await detect(handle)).toEqual({ installed: false });
  });
});

describe('zidPubkey()', () => {
  it('returns classical + post-quantum keys', async () => {
    request.mockResolvedValue({ pubkey: 'ed25519hex', pq_pubkey: 'xwinghex', pq_suite: 'xwing-v1' });
    expect(await zidPubkey(handle)).toEqual({
      pubkey: 'ed25519hex',
      pq_pubkey: 'xwinghex',
      pq_suite: 'xwing-v1',
    });
  });

  it('maps a wallet error to a typed ZafuError', async () => {
    request.mockResolvedValue({ error: 'wallet locked' });
    await expect(zidPubkey(handle)).rejects.toMatchObject({ code: 'locked' });
  });
});

describe('encryptFor()', () => {
  it('uses the post-quantum path when the recipient advertises pq_pubkey', async () => {
    request.mockResolvedValue({ ciphertext: 'c', ephemeral_pubkey: '' });
    const out = await encryptFor(handle, { pubkey: 'ed', pq_pubkey: 'xw' }, new Uint8Array([1, 2, 3]));
    expect(out.postQuantum).toBe(true);
    expect(request).toHaveBeenCalledWith(
      'zafu_encrypt',
      expect.objectContaining({ recipient_pq: 'xw' }),
    );
  });

  it('falls back to the classical path without a pq_pubkey', async () => {
    request.mockResolvedValue({ ciphertext: 'c', ephemeral_pubkey: 'eph' });
    const out = await encryptFor(handle, { pubkey: 'ed' }, new Uint8Array([9]));
    expect(out.postQuantum).toBe(false);
    const [, req] = request.mock.calls[0]!;
    expect(req).not.toHaveProperty('recipient_pq');
  });

  it('throws typed on a denied response', async () => {
    request.mockResolvedValue({ error: 'permission denied' });
    await expect(
      encryptFor(handle, { pubkey: 'ed' }, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('throws transport_error when the wallet is unreachable', async () => {
    request.mockRejectedValue(new Error('no wallet'));
    await expect(
      encryptFor(handle, { pubkey: 'ed' }, new Uint8Array([1])),
    ).rejects.toBeInstanceOf(ZafuError);
  });
});

describe('decryptFrom()', () => {
  it('round-trips base64 plaintext back to bytes', async () => {
    request.mockResolvedValue({ plaintext: btoa(String.fromCharCode(7, 8, 9)) });
    const out = await decryptFrom(handle, { ciphertext: 'c', ephemeral_pubkey: '' });
    expect([...out]).toEqual([7, 8, 9]);
  });
});

describe('structured error code (prefer code over string-matching)', () => {
  it('uses the wallet code even when the message string would not match', async () => {
    // an opaque/localised message the string matcher would miss, plus a real code.
    request.mockResolvedValue({ error: 'no puedes hacer eso', code: 'rate_limited' });
    await expect(zidPubkey(handle)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('reads the code from a { success:false } shape too', async () => {
    request.mockResolvedValue({ success: false, error: 'x', code: 'locked' });
    await expect(
      encryptFor(handle, { pubkey: 'ed' }, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  it('falls back to string-matching for older wallets with no code', async () => {
    request.mockResolvedValue({ error: 'rate limited: max 100 calls per minute' });
    await expect(zidPubkey(handle)).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('sign()', () => {
  it('returns the signature + signing pubkey on success', async () => {
    request.mockResolvedValue({ success: true, signature: 'sighex', publicKey: 'edpub' });
    const out = await sign(handle, 'deadbeef', 'Login to example.com');
    expect(out).toEqual({ signature: 'sighex', publicKey: 'edpub' });
    expect(request).toHaveBeenCalledWith(
      'zafu_sign',
      expect.objectContaining({ type: 'zafu_sign', challengeHex: 'deadbeef' }),
    );
  });

  it('throws a typed denied error when the user declines', async () => {
    request.mockResolvedValue({ success: false, error: 'user denied' });
    await expect(sign(handle, 'ab')).rejects.toMatchObject({ code: 'denied' });
  });

  it('throws wallet_error when the response is missing the signature', async () => {
    request.mockResolvedValue({ success: true, publicKey: 'edpub' });
    await expect(sign(handle, 'ab')).rejects.toMatchObject({ code: 'wallet_error' });
  });

  it('signBytes hex-encodes the message', async () => {
    request.mockResolvedValue({ success: true, signature: 's', publicKey: 'p' });
    await signBytes(handle, new Uint8Array([0x00, 0x0f, 0xff]));
    expect(request).toHaveBeenCalledWith(
      'zafu_sign',
      expect.objectContaining({ challengeHex: '000fff' }),
    );
  });
});

describe('requireWallet()', () => {
  it('throws unavailable when no wallet is reachable', async () => {
    detectZafu.mockResolvedValue(null);
    await expect(requireWallet()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('throws incompatible when the wallet shares no protocol major', async () => {
    request.mockResolvedValue({ zafu: true, version: '99', protocolVersion: 2, protocolVersions: [2] });
    await expect(requireWallet(handle)).rejects.toMatchObject({ code: 'incompatible' });
  });

  it('returns the handle when a compatible wallet is present', async () => {
    request.mockResolvedValue({ zafu: true, version: '28.1.0', protocolVersion: 1, protocolVersions: [1] });
    expect(await requireWallet(handle)).toBe(handle);
  });
});
