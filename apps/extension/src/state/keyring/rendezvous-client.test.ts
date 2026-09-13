import { describe, expect, it } from 'vitest';
import { generateRoomCode, roomIdFromCode } from './rendezvous-client';

describe('generateRoomCode', () => {
  it('is a number and two bip39 words (wormhole-style)', () => {
    const code = generateRoomCode();
    expect(code.split('-')).toHaveLength(3);
    // e.g. 7-crossover-clockwork; matches zcli + poker-escrow so codes resolve
    // across all three clients
    expect(code).toMatch(/^[1-9][0-9]*-[a-z]+-[a-z]+$/);
  });

  it('does not repeat', () => {
    expect(generateRoomCode()).not.toBe(generateRoomCode());
  });
});

describe('roomIdFromCode', () => {
  it('is 64 hex', async () => {
    expect(await roomIdFromCode('orbit-velvet-lantern-cove')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forgives case, separators, and whitespace', async () => {
    const canonical = await roomIdFromCode('orbit-velvet-lantern-cove');
    for (const mangled of [
      'Orbit Velvet Lantern Cove',
      '  orbit_velvet_lantern_cove  ',
      'orbit,velvet, lantern,cove',
    ]) {
      expect(await roomIdFromCode(mangled)).toBe(canonical);
    }
  });

  it('distinguishes different codes', async () => {
    expect(await roomIdFromCode('a-b-c-d')).not.toBe(await roomIdFromCode('a-b-c-e'));
  });
});
