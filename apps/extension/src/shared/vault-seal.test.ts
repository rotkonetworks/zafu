import { describe, expect, test } from 'vitest';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@rotko/penumbra-types/base64';
import { Key } from '@repo/encryption/key';
import { issueWorkerKey, openKeySeal, sealKeyTo } from './vault-seal';

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
});
