export enum ZafuConnection {
  Connect = 'Connect',
  Disconnect = 'Disconnect',
  Load = 'Load',
}

export const isZafuConnection = (value: unknown): value is ZafuConnection =>
  typeof value === 'string' && value in ZafuConnection;
