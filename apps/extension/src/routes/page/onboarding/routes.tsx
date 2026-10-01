import type { RouteObject } from 'react-router-dom';
import { PagePath } from '../paths';

type Screens = typeof import('./screens');

// one chunk for the whole flow, fetched once, so a step never waits on a load
const screen = (name: keyof Screens) => () =>
  import('./screens').then(m => ({ Component: m[name] }));

const P = PagePath;

export const onboardingRoute: RouteObject = {
  path: P.WELCOME,
  lazy: screen('Onboarding'),
  children: [
    { index: true, lazy: screen('OnboardingStart') },
    { path: P.CHOOSE, lazy: screen('OnboardingChoose') },
    { path: P.CREATE_PASSWORD, lazy: screen('SetPassword') },
    { path: P.GENERATE_SEED_PHRASE, lazy: screen('GenerateSeedPhrase') },
    { path: P.CHECK_SEED_PHRASE, lazy: screen('CheckSeedPhrase') },
    { path: P.IMPORT_SEED_PHRASE, lazy: screen('ImportSeedPhrase') },
    { path: P.IMPORT_BIRTHDAY, lazy: screen('ImportBirthday') },
    { path: P.IMPORT_PASSWORD, lazy: screen('SetPassword') },
    { path: P.IMPORT_ZIGNER, lazy: screen('ImportZigner') },
    { path: P.ZIGNER_PASSWORD, lazy: screen('SetPassword') },
    // the ledger entry is flagged in start.tsx; the route stays so it type-checks
    { path: P.CONNECT_LEDGER, lazy: screen('ConnectLedger') },
    { path: P.ONBOARDING_SUCCESS, lazy: screen('OnboardingSuccess') },
  ],
};
