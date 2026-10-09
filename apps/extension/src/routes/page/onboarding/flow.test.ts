import { describe, expect, it } from 'vitest';
import { PagePath } from '../paths';
import { SEED_PHRASE_ORIGIN } from './password/types';
import {
  PASSWORD_PATH,
  originOf,
  passwordStrength,
  penumbraOnlyImport,
  phraseNote,
  screenFor,
} from './flow';

describe('onboarding flow', () => {
  it('walks back along each path to the welcome screen', () => {
    for (const start of [
      PagePath.CHECK_SEED_PHRASE,
      PagePath.IMPORT_PASSWORD,
      PagePath.ZIGNER_PASSWORD,
      PagePath.VIEWING_KEY_PASSWORD,
      PagePath.CONNECT_LEDGER,
    ]) {
      let at: PagePath | undefined = start;
      const seen: PagePath[] = [];
      while (at) {
        seen.push(at);
        at = screenFor(at).back;
      }
      expect(seen.at(-1)).toBe(PagePath.WELCOME);
    }
  });

  it('shows steps only between welcome and done', () => {
    expect(screenFor(PagePath.WELCOME).step).toBeUndefined();
    expect(screenFor(PagePath.CHOOSE).step).toBeUndefined();
    expect(screenFor(PagePath.ONBOARDING_SUCCESS).step).toBeUndefined();
    expect(screenFor(PagePath.CREATE_PASSWORD).step).toEqual([1, 3]);
    expect(screenFor(PagePath.IMPORT_PASSWORD).step).toEqual([3, 3]);
    expect(screenFor(PagePath.VIEWING_KEY_PASSWORD).step).toEqual([3, 3]);
  });

  it('reads the password origin back from its path', () => {
    for (const origin of Object.keys(PASSWORD_PATH) as (keyof typeof PASSWORD_PATH)[]) {
      expect(originOf(PASSWORD_PATH[origin])).toBe(origin);
    }
    expect(originOf(PagePath.CREATE_PASSWORD)).toBe(SEED_PHRASE_ORIGIN.NEWLY_GENERATED);
    expect(originOf(PagePath.WELCOME)).toBeUndefined();
  });

  it('rates passwords by length, then variety', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('abcdefg')).toBe(0);
    expect(passwordStrength('abcdefgh')).toBe(1);
    expect(passwordStrength('ink and gold road')).toBe(4);
    expect(passwordStrength('inkandgoldroadxx')).toBe(3);
  });

  it('a 12-word import skips the zcash birthday, and counts its steps honestly', () => {
    expect(penumbraOnlyImport(SEED_PHRASE_ORIGIN.IMPORTED, 12)).toBe(true);
    expect(penumbraOnlyImport(SEED_PHRASE_ORIGIN.IMPORTED, 24)).toBe(false);
    expect(penumbraOnlyImport(SEED_PHRASE_ORIGIN.NEWLY_GENERATED, 12)).toBe(false);

    expect(screenFor(PagePath.IMPORT_SEED_PHRASE, true).step).toEqual([1, 2]);
    expect(screenFor(PagePath.IMPORT_PASSWORD, true)).toMatchObject({
      back: PagePath.IMPORT_SEED_PHRASE,
      step: [2, 2],
    });
    // 24 words keep the birthday step
    expect(screenFor(PagePath.IMPORT_PASSWORD).back).toBe(PagePath.IMPORT_BIRTHDAY);
    // other paths ignore the length
    expect(screenFor(PagePath.CREATE_PASSWORD, true).step).toEqual([1, 3]);
  });

  it('says a whole 12-word phrase opens penumbra only, in its one line', () => {
    expect(phraseNote({ count: 12, whole: true, valid: true })).toBe(
      '12 words · this phrase opens penumbra only',
    );
    expect(phraseNote({ count: 24, whole: true, valid: true })).toBe('24 words · valid phrase');
    // not yet a phrase: nothing is promised about what it opens
    expect(phraseNote({ count: 12, whole: true, valid: false })).toBe(
      "these words don't form a phrase yet · please check the order",
    );
  });
});
