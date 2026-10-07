import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import { UserChoice } from '@repo/storage-chrome/records';

const popup = vi.hoisted(() => vi.fn());
vi.mock('../../popup', () => ({ popup }));
const openPanelOnGesture = vi.hoisted(() => vi.fn());
vi.mock('../../side-panel-pref', () => ({ openPanelOnGesture }));

import { isReservedChallenge, signRequestListener, type SignResponse } from './sign-request';
import { pqKeyAuthMessage } from '@zafu/pq';
import { bytesToHex } from '@noble/hashes/utils';
import { SIGN_REQUEST_TYPE } from './zafu-method-names';

const ORIGIN = 'https://login.example';
const sender: chrome.runtime.MessageSender = {
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  origin: ORIGIN,
  url: `${ORIGIN}/index.html`,
  documentLifecycle: 'active',
  documentId: 'doc-1',
};

const ask = (): Promise<SignResponse> =>
  new Promise(resolve => {
    signRequestListener({ type: SIGN_REQUEST_TYPE, challengeHex: 'abcd' }, sender, resolve);
  });

const selectVault = async (type: string, insensitive: Record<string, unknown> = {}) => {
  const vault = {
    id: 'v1',
    type,
    name: 'w',
    createdAt: 0,
    encryptedData: '',
    salt: '',
    insensitive,
  };
  await localExtStorage.set('vaults', [vault] as never);
  await localExtStorage.set('selectedVaultId', 'v1');
};

beforeEach(() => {
  openPanelOnGesture.mockReset();
  popup.mockReset();
  popup.mockResolvedValue({ choice: UserChoice.Denied });
});

describe('zafu_sign: only a signer that can sign a ZID is offered it', () => {
  it.each([
    ['keystone', 'zigner-zafu', { coldSignerType: 'keystone' }, /keystone cannot sign/],
    ['ledger cold import', 'zigner-zafu', { coldSignerType: 'ledger' }, /ledger cannot sign/],
    ['ledger vault', 'ledger', {}, /ledger cannot sign/],
    ['viewing key', 'zigner-zafu', { coldSignerType: 'viewing-key' }, /viewing key/],
    ['foreign cold signer', 'zigner-zafu', { coldSignerType: 'abacus' }, /does not recognise/],
    ['trezor vault', 'trezor', {}, /does not recognise/],
  ])('refuses a %s without opening a popup', async (_, type, insensitive, reason) => {
    await selectVault(type, insensitive);
    const res = await ask();
    expect(res.success).toBe(false);
    expect(res).toMatchObject({ code: 'not_available', error: expect.stringMatching(reason) });
    expect(popup).not.toHaveBeenCalled();
  });

  it('offers a zigner the airgap QR flow', async () => {
    await selectVault('zigner-zafu', { coldSignerType: 'zigner', zid: 'pk' });
    await ask();
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup.mock.calls[0]![1]).toMatchObject({ isAirgap: true, zidPubkey: 'pk' });
  });

  it('signs a phrase wallet in place', async () => {
    await selectVault('mnemonic');
    await ask();
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup.mock.calls[0]![1]).toMatchObject({ isAirgap: false });
  });
});

describe("zafu_sign: zafu's own messages are not signable", () => {
  const askHex = (challengeHex: string): Promise<SignResponse> =>
    new Promise(resolve => {
      signRequestListener({ type: SIGN_REQUEST_TYPE, challengeHex }, sender, resolve);
    });

  it('refuses a PQ prekey authentication message before any popup', async () => {
    const msg = pqKeyAuthMessage('xwing-v1', ORIGIN, 7, new Uint8Array(32).fill(1));
    const res = await askHex(bytesToHex(msg));
    expect(res).toMatchObject({ success: false, code: 'invalid_request' });
    expect(popup).not.toHaveBeenCalled();
  });

  it('leaves ordinary challenges alone, including ones that mention zafu', () => {
    expect(isReservedChallenge(bytesToHex(new TextEncoder().encode('zafu-login nonce 42')))).toBe(
      false,
    );
    expect(isReservedChallenge('abcd')).toBe(false);
    expect(isReservedChallenge('00000005' + '7a6166752d')).toBe(true);
  });
});

describe('zafu_sign: the side panel opens while the click still counts', () => {
  it('opens it in the same task as the request, before any await', () => {
    signRequestListener({ type: SIGN_REQUEST_TYPE, challengeHex: 'abcd' }, sender, () => undefined);
    expect(openPanelOnGesture).toHaveBeenCalledWith(sender);
  });

  it('opens nothing for a malformed challenge', () => {
    signRequestListener({ type: SIGN_REQUEST_TYPE, challengeHex: 'xyz' }, sender, () => undefined);
    expect(openPanelOnGesture).not.toHaveBeenCalled();
  });
});
