export enum ZignerControl {
  Preconnect = 'Preconnect',
  Init = 'Init',
  End = 'End',
}

export const isZignerControl = (value: unknown): value is ZignerControl =>
  typeof value === 'string' && value in ZignerControl;
