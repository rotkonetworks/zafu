import { describe, expect, it } from 'vitest';
import { identityLabel } from './use-identity';

describe('identityLabel', () => {
  it('uses the name the person chose', () => {
    expect(identityLabel(0, [{ index: 0, label: 'tommi' }])).toBe('tommi');
  });
  it('reads an unnamed or placeholder pin as no name', () => {
    expect(identityLabel(0, [{ index: 0, label: 'gen 0' }])).toBe('personal');
    expect(identityLabel(2, [{ index: 2, label: '  ' }])).toBe('identity 2');
    expect(identityLabel(1, [])).toBe('identity 1');
  });
});
