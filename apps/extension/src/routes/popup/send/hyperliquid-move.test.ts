import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { userActionDigest } from '@repo/wallet/networks/hyperliquid/sign';
import { deriveHyperliquidAddress } from '@repo/wallet/networks/hyperliquid/derive';
import { checkMove, moveOf, signMove, stageAfter } from './hyperliquid-move';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATH = "m/44'/60'/0'/0/0";
const OWN = deriveHyperliquidAddress(PHRASE, PATH);
const TO = '0x5e9ee1089755c3435139848e47e6635505d5a13a';
const balances = { perp: 10_000_000n, spot: 3_500_000n };

describe('which action a choice means', () => {
  it('withdraws from perp whatever account was picked for sends', () => {
    expect(moveOf('withdraw', 'spot')).toBe('withdraw3');
    expect(moveOf('withdraw', 'perp')).toBe('withdraw3');
    expect(moveOf('send', 'perp')).toBe('usdSend');
    expect(moveOf('send', 'spot')).toBe('spotSend');
  });
});

describe('checkMove', () => {
  const check = (move: Parameters<typeof checkMove>[0]['move'], to: string, amount: string) =>
    checkMove({ move, to, amount, balances, own: OWN });

  it('passes a move the account can make, in millionths', () => {
    expect(check('usdSend', TO, '10')).toEqual({ micro: 10_000_000n });
    expect(check('spotSend', TO, '3.5')).toEqual({ micro: 3_500_000n });
    expect(check('withdraw3', OWN, '1.000001')).toEqual({ micro: 1_000_001n });
  });

  it('never lets more leave than the account it leaves from has', () => {
    expect(check('usdSend', TO, '10.000001').micro).toBeUndefined();
    // spot is checked against spot, not against the larger perp balance
    expect(check('spotSend', TO, '3.500001')).toEqual({
      field: 'amount',
      problem: 'the spot account has 3.5 usdc to move',
    });
  });

  it("stops a withdrawal that hyperliquid's fee would swallow", () => {
    expect(check('withdraw3', TO, '1').micro).toBeUndefined();
    expect(check('withdraw3', TO, '0.5').problem).toMatch(/1 usdc fee/);
    // a send has no fee to clear
    expect(check('usdSend', TO, '0.5')).toEqual({ micro: 500_000n });
  });

  it('stops a bad address, a send to itself, and an amount it cannot read', () => {
    expect(check('usdSend', '0x1234', '1').problem).toMatch(/0x address/);
    expect(check('usdSend', OWN.toUpperCase().replace('0X', '0x'), '1').problem).toMatch(
      /this account/,
    );
    for (const bad of ['1.0000001', '1e3', '-1', 'abc', '1,5']) {
      expect(check('usdSend', TO, bad).micro).toBeUndefined();
    }
  });

  it('says nothing and passes nothing while a field is empty or balances are unread', () => {
    expect(check('usdSend', '', '')).toEqual({});
    expect(check('usdSend', TO, '')).toEqual({});
    expect(check('usdSend', '', '1')).toEqual({});
    expect(check('usdSend', TO, '0')).toEqual({});
    expect(
      checkMove({ move: 'usdSend', to: TO, amount: '1', balances: undefined, own: OWN }),
    ).toEqual({});
  });
});

describe('signMove', () => {
  const args = { mnemonic: PHRASE, path: PATH, address: OWN, to: TO, micro: 2_500_000n, now: 77 };

  it('signs exactly what review showed, with the key of the address shown', () => {
    const signed = signMove({ ...args, move: 'withdraw3' });
    expect(signed.action).toEqual({
      type: 'withdraw3',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      destination: TO,
      amount: '2.5',
      time: 77,
    });
    expect(signed.nonce).toBe(77);
    const { r, s, v } = signed.signature;
    const pub = new secp256k1.Signature(BigInt(r), BigInt(s))
      .addRecoveryBit(v - 27)
      .recoverPublicKey(userActionDigest(signed.action))
      .toRawBytes(false);
    expect(`0x${bytesToHex(keccak_256(pub.slice(1)).slice(12))}`).toBe(OWN);
  });

  it('refuses to sign when the path no longer gives the address the balances were read for', () => {
    expect(() => signMove({ ...args, move: 'usdSend', path: "m/44'/60'/2000'/1/0" })).toThrow(
      /no longer matches/,
    );
  });
});

describe('what an answer means for the next step', () => {
  it('lets only a first refusal start over; an unclear answer keeps the signed action', () => {
    expect(stageAfter('ok', false)).toBe('done');
    expect(stageAfter('ok', true)).toBe('done');
    expect(stageAfter('refused', false)).toBe('refused');
    expect(stageAfter('unclear', false)).toBe('unclear');
    expect(stageAfter('unclear', true)).toBe('unclear');
  });

  it('sends the person to their balance when a retry is refused: the first try may have landed', () => {
    expect(stageAfter('refused', true)).toBe('check');
  });
});
