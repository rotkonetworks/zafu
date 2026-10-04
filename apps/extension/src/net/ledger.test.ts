import { describe, expect, it } from 'vitest';
import {
  exportEgressChoices,
  importEgressChoices,
  readNetEgress,
  setDestinationDecision,
  setDestinationOptIn,
} from './ledger';

describe('egress choices in the personal-data backup', () => {
  it('round-trips the user decisions and nothing else', async () => {
    await setDestinationDecision('blocked.example', 'blocked');
    await setDestinationDecision('allowed.example', 'allowed');
    await setDestinationDecision('asked.example', 'pending');
    await setDestinationOptIn('zcash-me', 'allowed');
    await setDestinationOptIn('near-swap', 'blocked');
    await setDestinationOptIn('thorname', 'allowed');

    const backup = await exportEgressChoices();
    expect(backup.hosts).toMatchObject({
      'blocked.example': 'blocked',
      'allowed.example': 'allowed',
    });
    expect(backup.hosts['asked.example']).toBeUndefined();
    expect(backup.optIns).toMatchObject({
      'zcash-me': 'allowed',
      'near-swap': 'blocked',
      thorname: 'allowed',
    });

    await chrome.storage.local.remove('netEgress');
    await importEgressChoices(JSON.parse(JSON.stringify(backup)) as typeof backup);
    const restored = await readNetEgress();
    expect(restored.destinations['blocked.example']?.state).toBe('blocked');
    expect(restored.destinations['allowed.example']?.state).toBe('allowed');
    expect(restored.optIns).toMatchObject({ 'zcash-me': 'allowed', 'near-swap': 'blocked' });
  });

  it('restores nothing from a backup made before the policy, or from junk', async () => {
    const before = await readNetEgress();
    await importEgressChoices(undefined);
    await importEgressChoices({
      hosts: { 'x.example': 'maybe' as never },
      optIns: { y: 'sure' as never },
    });
    const after = await readNetEgress();
    expect(after.destinations['x.example']).toBeUndefined();
    expect(after.optIns['y']).toBeUndefined();
    expect(Object.keys(after.optIns)).toEqual(Object.keys(before.optIns));
  });
});
