import { describe, expect, it } from 'vitest';
import { errText, storageFailure } from './error-text';

describe('errText', () => {
  it('names a DOMException instead of printing [object DOMException]', () => {
    const e = new DOMException('The database connection is closing.', 'InvalidStateError');
    expect(errText(e)).toBe('InvalidStateError: The database connection is closing.');
  });

  it('keeps errors, strings and events to one line', () => {
    expect(errText(new Error('Unknown latest block height'))).toBe(
      'Error: Unknown latest block height',
    );
    expect(errText(new TypeError(''))).toBe('TypeError');
    expect(errText('plain')).toBe('plain');
    expect(errText(new MessageEvent('message', { data: 1 }))).toBe("MessageEvent 'message'");
    expect(errText(undefined)).toBe('undefined');
  });
});

describe('storageFailure', () => {
  it('reopens a closed connection and stops on a full disk or a newer database', () => {
    expect(storageFailure(new DOMException('closing', 'InvalidStateError'))).toBe('reopen');
    expect(storageFailure(new DOMException('full', 'QuotaExceededError'))).toBe('fatal');
    expect(storageFailure(new DOMException('newer', 'VersionError'))).toBe('fatal');
    const wrapped = new Error('save failed', {
      cause: new DOMException('closing', 'InvalidStateError'),
    });
    expect(storageFailure(wrapped)).toBe('reopen');
  });

  it('leaves network failures alone, aborts included', () => {
    expect(storageFailure(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(storageFailure(new DOMException('aborted', 'AbortError'))).toBeUndefined();
    expect(storageFailure(new DOMException('slow', 'TimeoutError'))).toBeUndefined();
  });
});
