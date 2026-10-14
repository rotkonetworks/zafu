import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SyncStatus } from './sync-status';

const text = (currentHeight: number) =>
  renderToStaticMarkup(
    <SyncStatus
      percent={0}
      currentHeight={currentHeight}
      targetHeight={4_501_017}
      startBlock={0}
    />,
  );

describe('sync status', () => {
  it('says how far behind once the scan height is known', () => {
    expect(text(4_500_000)).toContain('1,017 blocks behind');
  });

  it('claims no distance before the first height arrives (a new pocket)', () => {
    expect(text(0)).not.toContain('blocks behind');
  });
});
