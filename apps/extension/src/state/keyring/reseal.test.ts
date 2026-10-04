import { describe, expect, test } from 'vitest';
import { Key } from '@repo/encryption/key';
import { Box, type BoxJson } from '@repo/encryption/box';
import { resealSnapshot } from './reseal';

const open = async (key: Key, box: BoxJson) => key.unseal(Box.fromJson(box));

describe('resealSnapshot', async () => {
  const from = (await Key.create('old')).key;
  const to = (await Key.create('new')).key;
  const other = (await Key.create('someone else')).key;

  test('moves boxes stored as objects, as JSON strings, and inside other boxes', async () => {
    const inner = (await from.seal('seed words')).toJson();
    const raw = {
      vaults: [{ id: 'v', encryptedData: JSON.stringify((await from.seal('phrase')).toJson()) }],
      penumbraWallets: {
        encrypted: (
          await from.seal(JSON.stringify([{ custody: { encryptedSeedPhrase: inner } }]))
        ).toJson(),
      },
      votingHotkeys: {
        'w:r': { hotkeySecretBox: JSON.stringify((await from.seal('hk')).toJson()) },
      },
    };
    const patch = await resealSnapshot(raw, from, to);

    const vault = (patch['vaults'] as { encryptedData: string }[])[0]!;
    expect(await open(to, JSON.parse(vault.encryptedData))).toBe('phrase');

    const wrapped = (patch['penumbraWallets'] as { encrypted: BoxJson }).encrypted;
    const list = JSON.parse((await open(to, wrapped))!);
    expect(await open(to, list[0].custody.encryptedSeedPhrase)).toBe('seed words');
    expect(await open(from, list[0].custody.encryptedSeedPhrase)).toBeNull();

    const hk = (patch['votingHotkeys'] as Record<string, { hotkeySecretBox: string }>)['w:r']!;
    expect(await open(to, JSON.parse(hk.hotkeySecretBox))).toBe('hk');
  });

  test('leaves plaintext and boxes under another key exactly as they were', async () => {
    const foreign = (await other.seal('not ours')).toJson();
    const raw = {
      zafuTheme: 'washi',
      activeWalletIndex: 0,
      list: [1, 'two', { three: null }],
      exported: { box: foreign },
      lookalike: '{"nonce": broken',
    };
    expect(await resealSnapshot(raw, from, to)).toEqual({});
  });

  test('keeps a sealed plaintext byte-for-byte when nothing inside it moved', async () => {
    const json = '{"b":1,  "a":[2]}';
    const patch = await resealSnapshot({ x: (await from.seal(json)).toJson() }, from, to);
    expect(await open(to, patch['x'] as BoxJson)).toBe(json);
  });
});
