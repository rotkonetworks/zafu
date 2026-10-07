/**
 * Pinned outputs from before the passkey hardening. A password or passkey a
 * person already uses must never change under them, so every refactor of the
 * derivation is checked against these bytes.
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { DEFAULT_IDENTITY, derivePassword, derivePrf, identityKey } from './identity';
import { createCredential, findCredential, legacyCredentialId } from './webauthn';

const MN =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MN2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// phrase, site, username, length, rotation, scheme -> password
const PASSWORDS: [string, string, string, number, number, 1 | 2, string][] = [
  [MN, 'github.com', 'alice', 32, 0, 2, 'G<)WH@t!d3S!<_&~+V~p{_SA!wh3H{3s'],
  [MN, 'https://www.bbc.co.uk/x', 'bob', 40, 3, 2, '?S+~aq)E5svqM$_!1nBo)NE&7vE|#P^31+W~NtVq'],
  [MN, 'app.webflow.io', 'carol', 24, 0, 2, 'w+I|itI5L!{03RXETT9``Ui='],
  [MN, 'login.myshopify.com', 'dan', 16, 1, 2, 'qh_@2cy<MrIreh>#'],
  [MN, 'mail.com', 'erin', 32, 0, 1, 'EF-E_hpAkomf#&5R+w(y;sXvMp~ia)TX'],
  [MN2, 'www.forum.z.cash', 'frank', 32, 2, 1, 'VaFwKQ^W`P$=ua1XtUaw7r3oWSOLFu}K'],
  [MN2, 'github.com', 'alice', 32, 0, 2, 'Xak!b@`&oZr`-mO0J$%nw0giEJB&e-+5'],
];

// phrase, rpId -> public key, credential id, prf('aabb'), pre-v2 credential id
const PASSKEYS: [string, string, string, string, string, string][] = [
  [
    MN,
    'example.com',
    '04514231ca690c62f778a46738ee83ffb9ceb8ba3592467e444ee4b23172e11f2783e33d2161cb57bca54e71ddf9eb83bf8af85adf745c4095129b9a87b9745657',
    '92079f5fba71d3b823c4d8f9805a1a67',
    '7e15b390ac3f56628fdaac8b2f4d14fad3d6bb3293436243f6b06f7662f1b723',
    '7a6166753aa379a6f6eeafb9a5',
  ],
  [
    MN,
    'webauthn.io',
    '048498b00bd8c75e486803e357fe1abb1ff5121d684fdc54882894a3b2f74aa82361c5a8c88a3be429668ebcfce947cd66e3ff9c7ea3f994126bbcf611ea63368b',
    '4ecca62f2a5f69c25139e8fadcc125ee',
    '81700118283ecfd746f66f8b355d360b2155fa873704b25bf53c61a9ceec093d',
    '7a6166753a74a6ea9213c99c2f',
  ],
  [
    MN2,
    'example.com',
    '04234dd7f2350d017006913913d117e60c7f6f11d6dcc283dcf9bc5a6131df3ffc8af99326c7880fe77e040b71476d28de440bf7ab0a85f82a59b0e22da3753278',
    '7c368ce20a09778f5f97eedb62374108',
    '64dfcb30dbac6737a956e5ee214b4cc0aced1a39d33e4bc79d93eed857c9922f',
    '7a6166753aa379a6f6eeafb9a5',
  ],
  [
    MN2,
    'webauthn.io',
    '045e88cab39ad420bc64aca00c4b97ce3eeb30a8d735c9b0653a3dfcb0dfe7196ac854da97243e11acc8f57fc8579387138dd3a209014989399339d3ff2a61c6a4',
    'f5f815d4f3b366d24f675e8f632de19a',
    '1829448485c4fda5a7f5e971f0885e08a19100ecffc13bf2c80ed7051f9fef1f',
    '7a6166753a74a6ea9213c99c2f',
  ],
];

describe('derivations made before the hardening stay byte for byte', () => {
  it.each(PASSWORDS)('password %#', (m, site, user, len, idx, scheme, want) => {
    expect(derivePassword(m, DEFAULT_IDENTITY, site, user, len, idx, scheme)).toBe(want);
  });

  it.each(PASSKEYS)('passkey %#', async (m, rp, pub, credId, prf, legacy) => {
    // a passkey made before v3 has no user id: it keeps its per-rpId key
    const identity = identityKey(m);
    const c = await createCredential(identity, rp, new Uint8Array(0), false);
    expect(bytesToHex(c.publicKey)).toBe(pub);
    expect(bytesToHex(c.credentialId)).toBe(credId);
    expect(bytesToHex(derivePrf(identity, rp, 'aabb'))).toBe(prf);
    expect(bytesToHex(legacyCredentialId(rp))).toBe(legacy);
    // and a site that stored either id gets that passkey back
    expect(await findCredential(identity, rp, [credId])).toEqual({ id: c.credentialId });
    expect(await findCredential(identity, rp, [legacy])).toEqual({ id: legacyCredentialId(rp) });
  });
});
