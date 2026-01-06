export enum ZignerConnection {
  Connect = 'Connect',
  Disconnect = 'Disconnect',
  Load = 'Load',
}

export const isZignerConnection = (value: unknown): value is ZignerConnection =>
  typeof value === 'string' && value in ZignerConnection;
