export interface ZignerRevoke {
  revoke: string;
}

export const isZignerRevokeMessage = (req: unknown): req is ZignerRevoke =>
  req != null && typeof req === 'object' && 'revoke' in req && typeof req.revoke === 'string';
