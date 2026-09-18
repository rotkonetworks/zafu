export enum PagePath {
  INDEX = '/',
  WELCOME = '/welcome',
  GENERATE_SEED_PHRASE = '/welcome/generate',
  IMPORT_SEED_PHRASE = '/welcome/import',
  /** Import: guided wallet-birthday (sync start) step. */
  IMPORT_BIRTHDAY = '/welcome/import/birthday',
  IMPORT_ZIGNER = '/welcome/import-zigner',
  CONNECT_LEDGER = '/welcome/connect-ledger',
  ONBOARDING_SUCCESS = '/welcome/success',
  SET_PASSWORD = '/welcome/set-password',
  /** Grant camera permission page - opened from popup, tells user to return */
  GRANT_CAMERA = '/grant-camera',
  /** QR scanner page - opened in new tab for scanning */
  QR_SCANNER = '/scan',
}
