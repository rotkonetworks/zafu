import { describe, expect, it } from 'vitest';
import {
  JAM_COMMON_ERA,
  JAM_SLOT_DURATION,
  PRESENCE_EPOCH_SLOTS,
  presenceEpoch,
} from './contact-discovery';
import { createPresenceScheduler, type PublishArgs } from './presence-scheduler';
import type { PresenceService } from './presence-service';
import type { PresenceRecord } from './presence-blob';

const EPOCH_SECS = PRESENCE_EPOCH_SLOTS * JAM_SLOT_DURATION; // 300

const rec: PresenceRecord = { sessionPub: new Uint8Array(32).fill(1), caps: 0 };
const peer = { id: 'B', friendPubHex: 'ab'.repeat(32), rootSecret: new Uint8Array(32).fill(5) };

// a PresenceService that records every publishSelf call
const spyService = () => {
  const calls: { peers: readonly unknown[]; epoch: number | undefined }[] = [];
  const service: PresenceService = {
    async publishSelf(_record, peers, epoch) {
      calls.push({ peers, epoch });
    },
    async findPresent() {
      return [];
    },
  };
  return { service, calls };
};

// a controllable clock
const clock = (startUnix: number) => {
  let t = startUnix;
  return { nowSeconds: () => t, advance: (secs: number) => (t += secs) };
};

describe('PresenceScheduler — fixed cadence', () => {
  it('publishes at most once per epoch (idempotent tick)', async () => {
    const { service, calls } = spyService();
    const c = clock(JAM_COMMON_ERA); // epoch 0
    const s = createPresenceScheduler(service, () => ({ record: rec, peers: [peer] }), {
      nowSeconds: c.nowSeconds,
    });

    const r1 = await s.tick();
    const r2 = await s.tick(); // same epoch
    expect(r1.published).toBe(true);
    expect(r2.published).toBe(false);
    expect(calls).toHaveLength(1);
    expect(s.lastPublishedEpoch).toBe(presenceEpoch(JAM_COMMON_ERA));
  });

  it('publishes again in the next epoch', async () => {
    const { service, calls } = spyService();
    const c = clock(JAM_COMMON_ERA);
    const s = createPresenceScheduler(service, () => ({ record: rec, peers: [peer] }), {
      nowSeconds: c.nowSeconds,
    });
    await s.tick();
    c.advance(EPOCH_SECS);
    const r = await s.tick();
    expect(r.published).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.epoch).toBe(calls[0]!.epoch! + 1);
  });

  it('publishes an all-dummy bucket when armed but friendless (fixed cadence holds)', async () => {
    const { service, calls } = spyService();
    const c = clock(JAM_COMMON_ERA);
    const s = createPresenceScheduler(service, () => ({ record: rec, peers: [] }), {
      nowSeconds: c.nowSeconds,
    });
    const r = await s.tick();
    expect(r.published).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.peers).toHaveLength(0); // empty peers -> ContactRelay pads to F dummies
  });

  it('skips (and does not claim the epoch) when not armed', async () => {
    const { service, calls } = spyService();
    const c = clock(JAM_COMMON_ERA);
    let armed: PublishArgs = null;
    const s = createPresenceScheduler(service, () => armed, { nowSeconds: c.nowSeconds });

    const r1 = await s.tick(); // not armed
    expect(r1.published).toBe(false);
    expect(calls).toHaveLength(0);
    // arming later IN THE SAME EPOCH still publishes (the epoch was not claimed)
    armed = { record: rec, peers: [peer] };
    const r2 = await s.tick();
    expect(r2.published).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
