import { PagePath } from '../paths';
import { SEED_PHRASE_ORIGIN } from './password/types';
import type { ScrollArt } from '../../../components/scroll-shell';

export type OnboardingArt = ScrollArt;

export interface OnboardingScreen {
  readonly art: OnboardingArt;
  readonly back?: PagePath;
  /** 1-based position and length of the path this screen sits on. */
  readonly step?: readonly [number, number];
}

const P = PagePath;

/** Every onboarding screen's chrome, so the shell never guesses from history. */
const SCREENS: Partial<Record<string, OnboardingScreen>> = {
  [P.WELCOME]: { art: 'samurai' },
  [P.CHOOSE]: { art: 'bamboo', back: P.WELCOME },
  [P.CREATE_PASSWORD]: { art: 'samurai', back: P.WELCOME, step: [1, 3] },
  [P.GENERATE_SEED_PHRASE]: { art: 'enso', back: P.CREATE_PASSWORD, step: [2, 3] },
  [P.CHECK_SEED_PHRASE]: { art: 'enso', back: P.GENERATE_SEED_PHRASE, step: [3, 3] },
  [P.IMPORT_SEED_PHRASE]: { art: 'bamboo', back: P.CHOOSE, step: [1, 3] },
  [P.IMPORT_BIRTHDAY]: { art: 'bamboo', back: P.IMPORT_SEED_PHRASE, step: [2, 3] },
  [P.IMPORT_PASSWORD]: { art: 'bamboo', back: P.IMPORT_BIRTHDAY, step: [3, 3] },
  [P.IMPORT_VIEWING_KEY]: { art: 'bamboo', back: P.CHOOSE, step: [1, 3] },
  [P.VIEWING_KEY_BIRTHDAY]: { art: 'bamboo', back: P.IMPORT_VIEWING_KEY, step: [2, 3] },
  [P.VIEWING_KEY_PASSWORD]: { art: 'bamboo', back: P.VIEWING_KEY_BIRTHDAY, step: [3, 3] },
  [P.IMPORT_SIGNER]: { art: 'enso', back: P.CHOOSE, step: [1, 2] },
  [P.ZIGNER_PASSWORD]: { art: 'enso', back: P.IMPORT_SIGNER, step: [2, 2] },
  [P.CONNECT_LEDGER]: { art: 'enso', back: P.CHOOSE },
  [P.PERSONALIZE]: { art: 'castle' },
  [P.ONBOARDING_SUCCESS]: { art: 'castle' },
};

/** A 12-word import is penumbra-only and has no zcash birthday to ask. */
const TWELVE: Partial<Record<string, OnboardingScreen>> = {
  [P.IMPORT_SEED_PHRASE]: { art: 'bamboo', back: P.CHOOSE, step: [1, 2] },
  [P.IMPORT_PASSWORD]: { art: 'bamboo', back: P.IMPORT_SEED_PHRASE, step: [2, 2] },
};

export const screenFor = (pathname: string, twelve = false): OnboardingScreen =>
  (twelve ? TWELVE[pathname] : undefined) ?? SCREENS[pathname] ?? { art: 'samurai' };

/** Where each path sets its password; the password screen reads its origin back from this. */
export const PASSWORD_PATH = {
  [SEED_PHRASE_ORIGIN.NEWLY_GENERATED]: P.CREATE_PASSWORD,
  [SEED_PHRASE_ORIGIN.IMPORTED]: P.IMPORT_PASSWORD,
  [SEED_PHRASE_ORIGIN.ZIGNER]: P.ZIGNER_PASSWORD,
  [SEED_PHRASE_ORIGIN.VIEWING_KEY]: P.VIEWING_KEY_PASSWORD,
} as const;

/** The paths that ask when the wallet began: the screen it follows, and the origin it serves. */
export const BIRTHDAY_PATH = {
  [SEED_PHRASE_ORIGIN.IMPORTED]: P.IMPORT_BIRTHDAY,
  [SEED_PHRASE_ORIGIN.VIEWING_KEY]: P.VIEWING_KEY_BIRTHDAY,
} as const;

/** A 12-word import: penumbra-only, so it skips the zcash birthday and never turns zcash on. */
export const penumbraOnlyImport = (origin: SEED_PHRASE_ORIGIN, words: number) =>
  origin === SEED_PHRASE_ORIGIN.IMPORTED && words === 12;

export type BirthdayOrigin = keyof typeof BIRTHDAY_PATH;

export const birthdayOriginOf = (pathname: string): BirthdayOrigin | undefined =>
  (Object.keys(BIRTHDAY_PATH) as BirthdayOrigin[]).find(o => BIRTHDAY_PATH[o] === pathname);

export type PasswordOrigin = keyof typeof PASSWORD_PATH;

export const originOf = (pathname: string): PasswordOrigin | undefined =>
  (Object.keys(PASSWORD_PATH) as PasswordOrigin[]).find(o => PASSWORD_PATH[o] === pathname);

/** 0-4 bars for the password meter: length first, then variety. */
export const passwordStrength = (pw: string): number => {
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter(r => r.test(pw)).length;
  return [8, 12, 16].filter(n => pw.length >= n).length + (pw.length >= 8 && variety >= 2 ? 1 : 0);
};
