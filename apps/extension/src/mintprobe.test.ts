import { describe, it, expect } from 'vitest';
import { createCredential, buildCredentialId } from './state/webauthn';
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
describe('real passkey mint', () => {
  it('mints for a normal rpId', () => {
    const r = createCredential(MN, 'confer.to');
    console.log('credId', Buffer.from(r.credentialId).toString('hex'), 'ad', r.authenticatorData.length, 'pub', r.publicKey.length);
    expect(r.publicKey.length).toBe(65);
  });
});
