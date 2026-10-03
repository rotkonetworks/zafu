import { describe, expect, it } from 'vitest';
import { bech32mWalletId } from '@penumbra-zone/bech32m/penumbrawalletid';
import { WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { withStoredView } from './stored-views';

const id = (b: number) => new WalletId({ inner: new Uint8Array(32).fill(b) }).toJsonString();
const db = (b: number, chain = 'penumbra-1') =>
  `viewdata/${chain}/${bech32mWalletId(WalletId.fromJsonString(id(b)))}`;

describe('withStoredView', () => {
  it('names the wallets that already hold part of the chain, under any chain id', () => {
    const stored = withStoredView(
      [id(1), id(2), id(3)],
      [db(1), db(3, 'penumbra-testnet'), 'zafu-zcash'],
    );
    expect([...stored]).toEqual([id(1), id(3)]);
  });

  it('a wallet with nothing stored is not among them', () => {
    expect(withStoredView([id(4)], ['zafu-zcash']).size).toBe(0);
  });

  it('an id it cannot read counts as stored, the safe side', () => {
    expect(withStoredView(['not json'], []).has('not json')).toBe(true);
  });
});
