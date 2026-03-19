export enum ZafuControl {
  Preconnect = 'Preconnect',
  Init = 'Init',
  End = 'End',
}

export const isZafuControl = (value: unknown): value is ZafuControl =>
  typeof value === 'string' && value in ZafuControl;
