export enum PagePath {
  INDEX = '/',
  WELCOME = '/welcome',
  CHOOSE = '/welcome/choose',
  CREATE_PASSWORD = '/welcome/create',
  GENERATE_SEED_PHRASE = '/welcome/generate',
  CHECK_SEED_PHRASE = '/welcome/generate/check',
  IMPORT_SEED_PHRASE = '/welcome/import',
  IMPORT_BIRTHDAY = '/welcome/import/birthday',
  IMPORT_PASSWORD = '/welcome/import/password',
  IMPORT_ZIGNER = '/welcome/import-zigner',
  ZIGNER_PASSWORD = '/welcome/import-zigner/password',
  CONNECT_LEDGER = '/welcome/connect-ledger',
  ONBOARDING_SUCCESS = '/welcome/success',
  /** Grant camera permission page - opened from popup, tells user to return */
  GRANT_CAMERA = '/grant-camera',
}
