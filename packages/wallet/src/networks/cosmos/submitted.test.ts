import { describe, expect, it } from 'vitest';
import { TimeoutError } from '@cosmjs/stargate';
import { submittedOnTimeout } from './signer';

describe('a broadcast that timed out after submitting', () => {
  it('is a submitted transaction with its hash, never an error a retry would pay twice for', () => {
    const r = submittedOnTimeout(new TimeoutError('was submitted but was not yet found', 'ABCD12'));
    expect(r).toMatchObject({ transactionHash: 'ABCD12', code: 0, height: 0 });
  });

  it('leaves every other failure an error', () => {
    const refused = new Error('insufficient funds');
    expect(() => submittedOnTimeout(refused)).toThrow(refused);
    // a fetch or abort timeout is not a submitted transaction
    const other = Object.assign(new Error('late'), { name: 'TimeoutError', txId: 'ABCD12' });
    expect(() => submittedOnTimeout(other)).toThrow(other);
  });
});
