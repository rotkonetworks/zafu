export enum PagePath {
  INDEX = '/',
  WELCOME = '/welcome',
  GENERATE_SEED_PHRASE = '/welcome/generate',
  IMPORT_SEED_PHRASE = '/welcome/import',
  IMPORT_ZIGNER = '/welcome/import-zigner',
  ONBOARDING_SUCCESS = '/welcome/success',
  SET_PASSWORD = '/welcome/set-password',
  /** Grant camera permission page - opened from popup, tells user to return */
  GRANT_CAMERA = '/grant-camera',
}
