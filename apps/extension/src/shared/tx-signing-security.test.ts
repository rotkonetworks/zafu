import { describe, expect, it } from 'vitest';
import {
  approvalWaitSeconds,
  opensGraceWindow,
  shouldPromptPassword,
  SIGN_GRACE_MS,
} from './tx-signing-security';

const NOW = 1_700_000_000_000;

describe('shouldPromptPassword', () => {
  it('foilhat always prompts, regardless of any grace window', () => {
    expect(shouldPromptPassword('foilhat', NOW, undefined)).toBe(true);
    expect(shouldPromptPassword('foilhat', NOW, NOW + SIGN_GRACE_MS)).toBe(true);
  });

  it('unlock-only never prompts', () => {
    expect(shouldPromptPassword('unlock-only', NOW, undefined)).toBe(false);
    expect(shouldPromptPassword('unlock-only', NOW, NOW - 1)).toBe(false);
  });

  describe('grace', () => {
    it('prompts when no grace window is set', () => {
      expect(shouldPromptPassword('grace', NOW, undefined)).toBe(true);
    });

    it('skips the prompt while the window is still in the future', () => {
      expect(shouldPromptPassword('grace', NOW, NOW + 1)).toBe(false);
      expect(shouldPromptPassword('grace', NOW, NOW + SIGN_GRACE_MS)).toBe(false);
    });

    it('prompts again exactly at and after expiry', () => {
      expect(shouldPromptPassword('grace', NOW, NOW)).toBe(true);
      expect(shouldPromptPassword('grace', NOW, NOW - 1)).toBe(true);
    });
  });

  it('fails safe to prompting for an unknown level', () => {
    expect(shouldPromptPassword('bogus' as never, NOW, NOW + SIGN_GRACE_MS)).toBe(true);
  });
});

describe('opensGraceWindow', () => {
  it('only grace opens a window', () => {
    expect(opensGraceWindow('grace')).toBe(true);
    expect(opensGraceWindow('foilhat')).toBe(false);
    expect(opensGraceWindow('unlock-only')).toBe(false);
  });
});

describe('approvalWaitSeconds', () => {
  it('keeps the 3s delay for foilhat and drops it otherwise', () => {
    expect(approvalWaitSeconds('foilhat')).toBe(3);
    expect(approvalWaitSeconds('grace')).toBe(0);
    expect(approvalWaitSeconds('unlock-only')).toBe(0);
  });
});
