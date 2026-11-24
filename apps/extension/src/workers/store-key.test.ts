import { describe, expect, it } from 'vitest';
import { storeKeyFingerprint, storeKeyFits } from './store-key';

const fvkA = 'aa'.repeat(96);
const fvkB = 'bb'.repeat(96);

describe('storeKeyFingerprint', () => {
  it('is the same for the same key, whatever its hex case', async () => {
    expect(await storeKeyFingerprint(fvkA)).toBe(await storeKeyFingerprint(fvkA.toUpperCase()));
  });

  it('tells two keys apart', async () => {
    expect(await storeKeyFingerprint(fvkA)).not.toBe(await storeKeyFingerprint(fvkB));
  });

  it('never holds the key', async () => {
    const fp = await storeKeyFingerprint(fvkA);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(fvkA).not.toContain(fp);
  });
});

describe('storeKeyFits', () => {
  it('lets a store no key has claimed take the first one', async () => {
    expect(storeKeyFits(undefined, await storeKeyFingerprint(fvkA))).toBe(true);
  });

  it('lets the key that filled a store resume it', async () => {
    const fp = await storeKeyFingerprint(fvkA);
    expect(storeKeyFits(fp, fp)).toBe(true);
  });

  it("refuses another wallet's key", async () => {
    expect(storeKeyFits(await storeKeyFingerprint(fvkA), await storeKeyFingerprint(fvkB))).toBe(
      false,
    );
  });
});
