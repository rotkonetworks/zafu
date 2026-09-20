import { describe, expect, it } from 'vitest';
import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { shortSymbol, symbolFromMetadata } from './asset-display';

describe('shortSymbol - never leaks a raw denom path', () => {
  it('strips the SI prefix on cosmos base denoms', () => {
    expect(shortSymbol('uusdc')).toBe('USDC');
    expect(shortSymbol('uosmo')).toBe('OSMO');
  });

  it('takes the last segment of an ibc transfer path', () => {
    expect(shortSymbol('transfer/channel-2/uusdc')).toBe('USDC');
  });

  it('collapses a bare ibc hash denom to a short tag', () => {
    expect(
      shortSymbol('ibc/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1'),
    ).toBe('IBC-955A');
  });

  it('collapses a path ending in an opaque hash', () => {
    expect(
      shortSymbol(
        'transfer/channel-0/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1',
      ),
    ).toBe('IBC-955A');
  });

  it('never returns a bech32m penumbra asset id', () => {
    expect(shortSymbol('passet1abcxyz')).toBe('Unknown');
  });

  it('handles empty / undefined input', () => {
    expect(shortSymbol(undefined)).toBe('Unknown');
    expect(shortSymbol('')).toBe('Unknown');
  });

  it('handles factory denoms by last segment', () => {
    expect(shortSymbol('factory/osmo1abc/upepe')).toBe('PEPE');
  });
});

describe('symbolFromMetadata - prefers registry symbol', () => {
  it('uses the metadata symbol when present', () => {
    expect(
      symbolFromMetadata(new Metadata({ symbol: 'USDC', display: 'transfer/channel-2/uusdc' })),
    ).toBe('USDC');
  });

  it('sanitizes the display denom when no symbol', () => {
    expect(symbolFromMetadata(new Metadata({ display: 'transfer/channel-2/uusdc' }))).toBe('USDC');
  });

  it('degrades to Unknown for empty metadata', () => {
    expect(symbolFromMetadata(new Metadata({}))).toBe('Unknown');
    expect(symbolFromMetadata(undefined)).toBe('Unknown');
  });
});
