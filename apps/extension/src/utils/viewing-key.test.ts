import { describe, expect, it } from 'vitest';
import { classifyViewingKey, viewingKeyDeviceId } from './viewing-key';

describe('classifyViewingKey', () => {
  it('recognises unified full viewing keys and their network', () => {
    expect(classifyViewingKey('uview1abc')).toEqual({
      kind: 'ufvk',
      mainnet: true,
      key: 'uview1abc',
    });
    expect(classifyViewingKey('  uviewtest1abc\n')).toMatchObject({ kind: 'ufvk', mainnet: false });
  });

  it('joins a key broken across lines by copy-paste', () => {
    expect(classifyViewingKey('uview1ab\ncd')).toMatchObject({ key: 'uview1abcd' });
  });

  it('refuses a seed phrase', () => {
    const seed = Array.from({ length: 24 }, () => 'abandon').join(' ');
    expect(classifyViewingKey(seed).kind).toBe('seed');
  });

  it('refuses spending keys', () => {
    expect(classifyViewingKey('secret-extended-key-main1xyz').kind).toBe('spending_key');
    expect(classifyViewingKey('usk1xyz').kind).toBe('spending_key');
  });

  it('names the keys zafu cannot sync', () => {
    expect(classifyViewingKey('uivk1xyz').kind).toBe('uivk');
    expect(classifyViewingKey('zxviews1xyz').kind).toBe('sapling');
    expect(classifyViewingKey('hello').kind).toBe('unknown');
    expect(classifyViewingKey('   ').kind).toBe('empty');
  });
});

describe('viewingKeyDeviceId', () => {
  it('is stable for the same key and differs between keys', async () => {
    expect(await viewingKeyDeviceId('uview1a')).toBe(await viewingKeyDeviceId('uview1a'));
    expect(await viewingKeyDeviceId('uview1a')).not.toBe(await viewingKeyDeviceId('uview1b'));
  });
});
