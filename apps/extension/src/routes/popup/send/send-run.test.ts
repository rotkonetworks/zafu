import { describe, expect, it, vi } from 'vitest';
import { BuildStopped, createBuildRegistry, isBuildStopped } from '../../../workers/build-abort';
import { SendRun } from './send-run';

/**
 * Cancel kills the attempt, for every signer zcash-send drives. The worker is
 * stood in for by the real build registry (workers/build-abort.ts) and a
 * wallet whose inputs are marked spent only at the broadcast, as the worker
 * does (markNotesSpentLocally after sendTransaction).
 */
const rig = () => {
  const worker = createBuildRegistry();
  const spent = new Set<string>();
  const discarded: [string, string | undefined][] = [];
  const failed: [string, string | undefined, string][] = [];
  const run = new SendRun({
    stopBuild: key => Promise.resolve(worker.stop(key)),
    discard: (opId, tempTxId) => discarded.push([opId, tempTxId]),
    fail: (opId, tempTxId, reason) => failed.push([opId, tempTxId, reason]),
  });
  run.tempTxId = 'temp:1';
  /** a worker build under the run's key: witnesses that never settle, then broadcast */
  const build = (hold = new Promise<void>(() => undefined)) => {
    const b = worker.begin(run.key);
    const done = (async () => {
      try {
        await b.race(hold);
        b.commit();
        spent.add('note-1');
        return 'txid';
      } finally {
        worker.end(run.key);
      }
    })();
    done.catch(() => undefined);
    return done;
  };
  return { worker, run, spent, discarded, failed, build };
};

const discardedOnly = (r: ReturnType<typeof rig>) => {
  expect(r.discarded).toEqual([[r.run.key, 'temp:1']]);
  expect(r.failed).toEqual([]);
  expect(r.spent.size).toBe(0);
  expect(r.run.discarded).toBe(true);
};

describe('cancel kills the attempt, per signer', () => {
  it('hot: stop this send aborts the worker build mid-witness', async () => {
    const r = rig();
    const building = r.build();
    await expect(r.run.cancel()).resolves.toBe('stopped');
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    discardedOnly(r);
  });

  it('hot: a dismissed password cancels before the build is sent, and it never starts', async () => {
    const r = rig();
    await expect(r.run.cancel()).resolves.toBe('stopped');
    // the build message arrives after the stop
    await expect(r.build(Promise.resolve())).rejects.toBeInstanceOf(BuildStopped);
    discardedOnly(r);
  });

  it('hot: past the broadcast it is already on its way, and nothing is discarded', async () => {
    const r = rig();
    let release!: () => void;
    const building = r.build(new Promise<void>(res => (release = res)));
    release();
    await building;
    await expect(r.run.cancel()).resolves.toBe('on-its-way');
    expect(r.discarded).toEqual([]);
  });

  it('zigner and keystone: back from the QR fails the parked round and discards', async () => {
    const r = rig();
    // the PCZT build already returned; the signer is parked on the scan
    r.worker.begin(r.run.key);
    r.worker.end(r.run.key);
    let fail!: (e: Error) => void;
    const parked = new Promise<string>((_, reject) => (fail = reject));
    parked.catch(() => undefined);
    r.run.hold(() => fail(new BuildStopped()));
    await expect(r.run.cancel()).resolves.toBe('stopped');
    await expect(parked).rejects.toSatisfy(isBuildStopped);
    discardedOnly(r);
  });

  it('zigner and keystone: cancelling while the PCZT builds stops the build', async () => {
    const r = rig();
    const building = r.build();
    await r.run.cancel();
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    discardedOnly(r);
  });

  it('ledger (shielded): back from the device aborts its round and the build behind it', async () => {
    const r = rig();
    const building = r.build();
    const device = new AbortController();
    r.run.hold(() => device.abort());
    await r.run.cancel();
    expect(device.signal.aborted).toBe(true);
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    discardedOnly(r);
  });

  it('ledger (transparent): cancelling closes the device channel before any broadcast', async () => {
    const r = rig();
    const close = vi.fn();
    r.run.hold(close);
    await r.run.cancel();
    expect(close).toHaveBeenCalledOnce();
    discardedOnly(r);
  });

  it('frost (self and airgap): leaving the room aborts the round and the build', async () => {
    const r = rig();
    const building = r.build();
    const room = r.run.signal();
    await r.run.cancel();
    expect(room.aborted).toBe(true);
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    discardedOnly(r);
  });

  it('a cold signer that handed back is broadcasting: cancel is refused', async () => {
    const r = rig();
    const round = vi.fn();
    r.run.hold(round);
    r.run.broadcasting();
    await expect(r.run.cancel()).resolves.toBe('on-its-way');
    expect(round).not.toHaveBeenCalled();
    expect(r.discarded).toEqual([]);
  });

  it('a build that never answers is ended as failed, not discarded', async () => {
    const r = rig();
    const building = r.build();
    await expect(r.run.cancel('took too long')).resolves.toBe('stopped');
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    expect(r.failed).toEqual([[r.run.key, 'temp:1', 'took too long']]);
    expect(r.discarded).toEqual([]);
    expect(r.spent.size).toBe(0);
  });

  it('a double tap discards once', async () => {
    const r = rig();
    r.build();
    await Promise.all([r.run.cancel(), r.run.cancel()]);
    expect(r.discarded).toHaveLength(1);
  });

  it('a home stop of the same key reaches the same build', async () => {
    const r = rig();
    const building = r.build();
    // home's in-flight card: a different window, the same worker and key
    expect(r.worker.stop(r.run.key)).toBe('stopped');
    await expect(building).rejects.toBeInstanceOf(BuildStopped);
    expect(r.spent.size).toBe(0);
  });
});
