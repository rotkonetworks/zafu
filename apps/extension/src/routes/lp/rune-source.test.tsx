/**
 * Where a pocket's rune key comes from is said where it is used: one line on
 * the position screen and the add, and a choice of two for a cold wallet at
 * the opt-in (never for a hot one).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { lpStore } from './store';
import { PositionScreen, SOURCE_LINE, TwoSidedScreen } from './screens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THOR1 = 'thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7';
const LP = 't1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p';
const POOL = { asset: 2_349_956_151n, rune: 4_115_368_117_505n, units: 3_902_179_720_724n };

const render = (node: React.ReactNode): string => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(node));
  const text = el.textContent ?? '';
  act(() => root.unmount());
  el.remove();
  return text;
};

const paired = (units: bigint) => ({
  at: 0,
  address: THOR1,
  balance: 100_000_000n,
  fee: 2_000_000n,
  account: { accountNumber: '1', sequence: '0' },
  paired: {
    units,
    pendingRune: 0n,
    pendingAsset: 0n,
    runeAddress: THOR1,
    assetAddress: LP,
    depositAsset: 1n,
    depositRune: 1n,
    lastAddHeight: 1,
    luviGrowthPct: 0,
  },
});

afterEach(() => lpStore.setState({ rune: undefined, runeRead: undefined, cold: false }));

describe('the rune key source, said where it is used', () => {
  for (const source of ['seed', 'random', 'fvk'] as const) {
    it(`the position screen names a ${source} key`, () => {
      lpStore.setState({
        phase: 'ready',
        lp: { index: 21, address: LP },
        rune: {
          index: 1,
          on: true,
          source,
          address: THOR1,
          ...(source === 'random' ? { box: '{}' } : {}),
        },
        runeRead: paired(1_000_000n),
        thor: {
          pool: { ...POOL, status: 'Available', tradingHalted: false, pendingRune: 0n, zecUsd: 1 },
          minSlipBps: 10n,
          lockupBlocks: 0,
          height: 10,
          runeUsd: 1,
          at: Date.now(),
        } as never,
      });
      const text = render(<PositionScreen onRecover={() => undefined} />);
      expect(text).toContain(SOURCE_LINE[source]);
      for (const other of Object.values(SOURCE_LINE).filter(l => l !== SOURCE_LINE[source])) {
        expect(text).not.toContain(other);
      }
    });
  }

  it('a cold wallet is offered the two choices once, a new key first', () => {
    lpStore.setState({ phase: 'ready', cold: true, rune: undefined, runeChoice: 'random' });
    const text = render(<TwoSidedScreen onAdd={() => undefined} />);
    expect(text).toContain('make a new key here');
    expect(text).toContain("use my device's viewing key");
    expect(text).toContain('kept in zafu and its backup, not on your device');
    expect(text).toContain('anyone with this viewing key can also move this rune');
    expect(text.indexOf('make a new key here')).toBeLessThan(text.indexOf('viewing key'));
  });

  it('a hot wallet sees no choice: its rune key is its recovery phrase', () => {
    lpStore.setState({ phase: 'ready', cold: false, rune: undefined });
    const text = render(<TwoSidedScreen onAdd={() => undefined} />);
    expect(text).not.toContain('make a new key here');
    expect(text).toContain('from your recovery phrase');
  });
});
