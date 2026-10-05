import { describe, expect, test } from 'vitest';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@penumbrafi/types/base64';
import { Key } from '@repo/encryption/key';
import { issueWorkerKey, openCall, openKeySeal, sealCallTo, sealKeyTo } from './vault-seal';

const session = async () => {
  const { key } = await Key.create('a password');
  return { key, json: await key.toJson() };
};

describe('vault seal', () => {
  test('the worker unwraps a decrypt-only, non-extractable copy of the session key', async () => {
    const { key, json } = await session();
    const box = await key.seal('the phrase');
    const opened = await openKeySeal(await sealKeyTo(json, await issueWorkerKey()));
    expect(opened).not.toBeNull();
    expect(opened!.extractable).toBe(false);
    expect(opened!.usages).toEqual(['decrypt']);
    await expect(crypto.subtle.exportKey('jwk', opened!)).rejects.toThrow();
    await expect(Key.unsealWith(opened!, box)).resolves.toBe('the phrase');
  });

  test('what crosses the message bus holds neither the key nor anything that opens it', async () => {
    const { json } = await session();
    const workerKey = await issueWorkerKey();
    const wire = JSON.stringify([workerKey, await sealKeyTo(json, workerKey)]);
    expect(wire).not.toContain(json._inner.k!);
    // structured-clone and JSON safe: plain strings only
    expect(JSON.parse(wire)).toEqual(JSON.parse(JSON.stringify(JSON.parse(wire))));
  });

  test('a worker key is spent by its first seal, opened or not', async () => {
    const { json } = await session();
    const seal = await sealKeyTo(json, await issueWorkerKey());
    expect(await openKeySeal(seal)).not.toBeNull();
    expect(await openKeySeal(seal)).toBeNull();
  });

  test('a seal opens only with the worker key it was made for', async () => {
    const { json } = await session();
    const [a, b] = [await issueWorkerKey(), await issueWorkerKey()];
    const seal = await sealKeyTo(json, a);
    // relabelled to another issued key: the HKDF salt and the ECDH secret differ
    expect(await openKeySeal({ ...seal, id: b.id })).toBeNull();
    // an unknown id
    expect(await openKeySeal({ ...seal, id: 'nobody' })).toBeNull();
  });

  test('a tampered wrap is refused', async () => {
    const { json } = await session();
    const seal = await sealKeyTo(json, await issueWorkerKey());
    const bytes = base64ToUint8Array(seal.wrapped);
    bytes[0] = bytes[0]! ^ 1;
    expect(await openKeySeal({ ...seal, wrapped: uint8ArrayToBase64(bytes) })).toBeNull();
  });

  test('a secret call: arguments and reply cross only sealed, and only the caller reads the reply', async () => {
    const to = await issueWorkerKey();
    const args = { keyPackageHex: 'cafe'.repeat(16), ephemeralSeedHex: 'beef'.repeat(16) };
    const { sealed, open } = await sealCallTo(to, args);
    expect(JSON.stringify(sealed)).not.toContain('cafe');
    expect(JSON.stringify(sealed)).not.toContain('beef');
    const call = await openCall(sealed);
    expect(call!.args).toEqual(args);
    const reply = await call!.reply({ nonces: 'f00d'.repeat(16) });
    expect(JSON.stringify(reply)).not.toContain('f00d');
    expect(await open(reply)).toEqual({ nonces: 'f00d'.repeat(16) });
    // the worker key is spent: the same call never opens twice
    expect(await openCall(sealed)).toBeNull();
    // and a reply cannot be taken for a call
    const other = await sealCallTo(await issueWorkerKey(), args);
    await expect(other.open(reply)).rejects.toThrow();
  });

  test('a secret call opens only with its own worker key, untampered', async () => {
    const [a, b] = [await issueWorkerKey(), await issueWorkerKey()];
    const { sealed } = await sealCallTo(a, { x: 1 });
    expect(await openCall({ ...sealed, id: b.id })).toBeNull();
    expect(await openCall(undefined)).toBeNull();
    const c = await issueWorkerKey();
    const tampered = await sealCallTo(c, { x: 1 });
    const bytes = base64ToUint8Array(tampered.sealed.ct);
    bytes[0] = bytes[0]! ^ 1;
    expect(await openCall({ ...tampered.sealed, ct: uint8ArrayToBase64(bytes) })).toBeNull();
  });
});
