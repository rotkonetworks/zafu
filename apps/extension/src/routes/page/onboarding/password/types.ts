export enum SEED_PHRASE_ORIGIN {
  IMPORTED = 'IMPORTED',
  NEWLY_GENERATED = 'NEWLY_GENERATED',
  ZIGNER = 'ZIGNER',
}

export interface LocationState {
  origin?: SEED_PHRASE_ORIGIN;
}
