import { describe, expect, it } from 'vitest';
import { hydrationGuard } from './persist';

describe('reads of encrypted storage, applied in order', () => {
  it('an older read that finishes last is not applied', () => {
    const next = hydrationGuard(() => 0);
    const first = next();
    const second = next();
    expect(second.newest()).toBe(true);
    expect(first.newest()).toBe(false);
  });

  it('a read a local write overtook leaves contacts as this realm has them', () => {
    let writes = 0;
    const next = hydrationGuard(() => writes);
    const read = next();
    // you renamed them while it was reading
    writes++;
    expect(read.newest()).toBe(true);
    expect(read.unwritten()).toBe(false);
    // the rename's own change starts a newer read, which applies
    expect(next().unwritten()).toBe(true);
  });
});
