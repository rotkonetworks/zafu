export enum SEED_PHRASE_ORIGIN {
  IMPORTED = 'IMPORTED',
  NEWLY_GENERATED = 'NEWLY_GENERATED',
  ZIGNER = 'ZIGNER',
  LEDGER = 'LEDGER',
}

export interface LocationState {
  origin?: SEED_PHRASE_ORIGIN;
}
