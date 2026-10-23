/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { calmError, waitCaughtUp } from './penumbra-send';

describe('a penumbra send waits for the wallet to catch up', () => {
  it('plans only once the wallet has read up to the tip', async () => {
    const said = [true, true, false];
    let asked = 0;
    await waitCaughtUp(async () => ({ catchingUp: said[asked++]! }), { everyMs: 1 });
    expect(asked).toBe(3);
  });

  it('gives up calmly when the chain never comes into reach, with nothing sent', async () => {
    await expect(
      waitCaughtUp(async () => ({ catchingUp: true }), { timeoutMs: 5, everyMs: 1 }),
    ).rejects.toThrow('nothing was sent');
  });

  it("reads the chain's 'already spent' as what it is", () => {
    const raw =
      '[unknown] Tendermint error 1: failed to deliver transaction: executing transaction: nullifier ab was already spent in "cd"';
    expect(calmError(raw)).toContain('spent a moment ago');
    expect(calmError('something else')).toBe('something else');
  });
});
