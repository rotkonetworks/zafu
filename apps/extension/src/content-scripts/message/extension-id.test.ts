import { describe, expect, test } from 'vitest';
import { answerExtensionId, askExtensionId } from './extension-id';

describe('extension id handoff', () => {
  test('answers the first ask, and only that one', () => {
    answerExtensionId('abc');

    expect(askExtensionId()).toBe('abc');
    // a page asking later learns nothing
    expect(askExtensionId()).toBe('');
  });

  test('is empty when nothing answers', () => {
    expect(askExtensionId()).toBe('');
  });

  test('ignores a non-string answer', () => {
    const forge = () => document.dispatchEvent(new CustomEvent('zafu-extension-id', { detail: 1 }));
    document.addEventListener('zafu-extension-id', forge, { once: true });

    expect(askExtensionId()).toBe('');
  });
});
