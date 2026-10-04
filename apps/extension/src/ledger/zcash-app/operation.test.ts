import { describe, expect, it } from 'vitest';
import { LedgerError, type LedgerSigningPhase } from './contract';
import { CTX, fakePczt, harness } from './fakes.test-util';
import { LedgerFlowError, LedgerOperation, classifyBroadcastError } from './operation';
import { recoverLedgerOperations } from './recovery';

const sendOp = (h: ReturnType<typeof harness>, pcztHex = fakePczt(1)) =>
  new LedgerOperation(h.deps, CTX, {
    kind: 'send',
    pcztHex,
    label: 'send 1 ZEC',
    coldSendId: 'cs1',
  });

describe('LedgerOperation', () => {
  it('happy path: validate, sign once, checkpoint, broadcast, acknowledge', async () => {
    const h = harness();
    const phases: LedgerSigningPhase['phase'][] = [];
    const steps: string[] = [];
    const out = await sendOp(h).run({
      onPhase: p => phases.push(p.phase),
      onStep: s => steps.push(s),
    });

    expect(out.status).toBe('broadcast');
    expect(h.protocol.validatePczt).toHaveBeenCalledTimes(1);
    expect(h.device.exchanges).toBe(1);
    expect(phases[0]).toBe('connecting');
    expect(phases).toContain('sending');
    expect(phases).toContain('review');
    expect(phases.at(-1)).toBe('done');
    expect(steps).toEqual(['signing', 'saving', 'broadcasting']);
    // broadcast got the extracted signed bytes and the build handle
    expect(h.broadcast).toHaveBeenCalledWith('w1', `tx${fakePczt(1)}d15a`, 'cs1');
    // acknowledged: nothing left to recover
    expect(await h.store.list()).toEqual([]);
    expect(h.tracked.at(-1)?.status).toBe('done');
  });

  it('opens the Zcash app when the device is on the dashboard', async () => {
    const h = harness();
    h.device.app = { name: 'BOLOS', version: '2.2.3' };
    const phases: string[] = [];
    await sendOp(h).run({ onPhase: p => phases.push(p.phase) });
    expect(h.device.openZcashApp).toHaveBeenCalledTimes(1);
    expect(phases.slice(0, 2)).toEqual(['connecting', 'open_app']);
  });

  it('refuses an app older than the signing minimum, before any exchange', async () => {
    const h = harness();
    h.device.app = { name: 'Zcash', version: '3.9.2' };
    await expect(sendOp(h).run()).rejects.toMatchObject({ failure: 'app_too_old' });
    expect(h.device.exchanges).toBe(0);
  });

  it('limit violation is rejected before the device is touched', async () => {
    const h = harness();
    await expect(sendOp(h, fakePczt(33)).run()).rejects.toMatchObject({
      failure: 'unsupported_transaction',
    });
    expect(h.device.currentApp).not.toHaveBeenCalled();
    expect(h.device.exchanges).toBe(0);
    expect(await h.store.list()).toEqual([]);
  });

  it('rejected on device: nothing is checkpointed or broadcast', async () => {
    const h = harness();
    h.device.behaviour = 'reject';
    const op = sendOp(h);
    const err = await op.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).failure).toBe('rejected');
    expect(op.isSigned).toBe(false);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(await h.store.list()).toEqual([]);

    // the user may approve on a retry: a new device approval is needed
    h.device.behaviour = 'approve';
    expect((await op.run()).status).toBe('broadcast');
    expect(h.device.exchanges).toBe(2);
  });

  it('cancel while the device is reviewing stops the flow', async () => {
    const h = harness();
    h.device.behaviour = 'hang';
    const ac = new AbortController();
    const phases: string[] = [];
    const running = sendOp(h).run({
      signal: ac.signal,
      onPhase: p => {
        phases.push(p.phase);
        if (p.phase === 'review') {
          ac.abort();
        }
      },
    });
    await expect(running).rejects.toMatchObject({ failure: 'cancelled' });
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(await h.store.list()).toEqual([]);
  });

  it('cancel before start never touches the device', async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(sendOp(h).run({ signal: ac.signal })).rejects.toMatchObject({
      failure: 'cancelled',
    });
    expect(h.device.currentApp).not.toHaveBeenCalled();
  });

  it('checkpoint failure retries with the signed bytes - no second approval', async () => {
    const h = harness();
    h.area.failNextSets = 1;
    const op = sendOp(h);
    const err = await op.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerFlowError);
    expect((err as LedgerFlowError).code).toBe('checkpoint_failed');
    expect(op.isSigned).toBe(true);
    expect(h.broadcast).not.toHaveBeenCalled();

    const out = await op.run();
    expect(out.status).toBe('broadcast');
    expect(h.device.exchanges).toBe(1);
    expect(h.extractTx).toHaveBeenCalledTimes(1);
  });

  it('retryable broadcast bookkeeping keeps the bytes; checkpoint is exact-idempotent', async () => {
    const h = harness();
    const op = sendOp(h);
    await op.run();
    await expect(
      h.store.checkpoint({
        operationId: 'x',
        walletId: 'w1',
        network: 'main',
        kind: 'send',
        signedTxHex: 'aa',
        txid: 't',
      }),
    ).resolves.toMatchObject({ state: 'signed' });
    await expect(
      h.store.checkpoint({
        operationId: 'x',
        walletId: 'w1',
        network: 'main',
        kind: 'send',
        signedTxHex: 'aa',
        txid: 't',
      }),
    ).resolves.toMatchObject({ state: 'signed' });
    await expect(
      h.store.checkpoint({
        operationId: 'x',
        walletId: 'w1',
        network: 'main',
        kind: 'send',
        signedTxHex: 'bb',
        txid: 't',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uncertain broadcast goes to recovery and is never re-signed or re-broadcast by the flow', async () => {
    const h = harness();
    h.broadcast.mockRejectedValueOnce(new Error('Failed to fetch'));
    const op = sendOp(h);
    const out = await op.run();
    expect(out.status).toBe('uncertain');
    const [meta] = await h.store.list();
    expect(meta?.state).toBe('broadcast_uncertain');
    expect(meta?.txid).toBe(`txid-${fakePczt(1)}d15a`);
    expect(h.tracked.at(-1)?.status).toBe('unknown');

    // retrying the flow returns the same verdict: no device, no broadcast
    expect(await op.run()).toEqual(out);
    expect(h.device.exchanges).toBe(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);

    // no new Ledger work while it is unresolved
    await expect(sendOp(h).run()).rejects.toMatchObject({ code: 'unresolved_operation' });
    expect(h.device.exchanges).toBe(1);

    // recovery: not seen and rebroadcast gets no answer -> keep waiting;
    // seen -> acknowledged
    h.broadcast.mockRejectedValueOnce(new Error('Failed to fetch'));
    const lookups = [false, true];
    const recoveryDeps = {
      store: h.store,
      broadcast: h.deps.broadcast,
      lookupTx: async () => ({ found: lookups.shift() ?? false }),
    };
    expect((await recoverLedgerOperations(recoveryDeps, CTX)).waiting).toHaveLength(1);
    expect((await recoverLedgerOperations(recoveryDeps, CTX)).resolved).toHaveLength(1);
    expect(await h.store.list()).toEqual([]);
    expect(h.broadcast).toHaveBeenCalledTimes(2); // the flow once, recovery once (same bytes)
    expect(h.device.exchanges).toBe(1);
  });

  it('a lost uncertain tx cannot wedge the wallet: rebroadcast refused -> discarded', async () => {
    const h = harness();
    h.broadcast.mockRejectedValueOnce(new Error('Failed to fetch'));
    expect((await sendOp(h).run()).status).toBe('uncertain');
    h.broadcast.mockRejectedValueOnce(new Error('broadcast failed (-25): tx expired'));
    const report = await recoverLedgerOperations(
      { store: h.store, broadcast: h.deps.broadcast, lookupTx: async () => ({ found: false }) },
      CTX,
    );
    expect(report.rejected).toHaveLength(1);
    expect(await h.store.list()).toEqual([]);
    // new Ledger work is allowed again
    expect((await sendOp(h).run()).status).toBe('broadcast');
  });

  it('a rejected broadcast is terminal: checkpoint discarded, retry refused', async () => {
    const h = harness();
    h.broadcast.mockRejectedValueOnce(new Error('broadcast failed (-26): bad-txns-inputs-spent'));
    const op = sendOp(h);
    await expect(op.run()).rejects.toMatchObject({ code: 'broadcast_rejected' });
    expect(await h.store.list()).toEqual([]);
    await expect(op.run()).rejects.toMatchObject({ code: 'not_retryable' });
    expect(h.device.exchanges).toBe(1);
  });

  it('an account or network change stops the flow before it broadcasts', async () => {
    const h = harness();
    const op = sendOp(h);
    const running = op.run({
      onPhase: p => {
        if (p.phase === 'review') {
          h.current.ok = false;
        }
      },
    });
    await expect(running).rejects.toMatchObject({ code: 'context_changed' });
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(await h.store.list()).toEqual([]);
  });

  it('recovery broadcasts a checkpoint the page never sent; "already known" is success', async () => {
    const h = harness();
    await h.store.checkpoint({
      operationId: 'orphan',
      walletId: 'w1',
      network: 'main',
      kind: 'shield',
      signedTxHex: 'deadbeef',
      txid: 'tid',
    });
    await h.store.checkpoint({
      operationId: 'other-net',
      walletId: 'w1',
      network: 'test',
      kind: 'send',
      signedTxHex: 'beef',
      txid: 'tid2',
    });
    h.broadcast.mockRejectedValueOnce(
      new Error('broadcast failed (18): transaction already in mempool'),
    );
    const report = await recoverLedgerOperations(
      { store: h.store, broadcast: h.deps.broadcast, lookupTx: async () => ({ found: false }) },
      CTX,
    );
    expect(report.broadcast).toEqual(['orphan']);
    expect(h.broadcast).toHaveBeenCalledWith('w1', 'deadbeef', undefined);
    // the testnet checkpoint is untouched on mainnet
    expect((await h.store.list()).map(m => m.operationId)).toEqual(['other-net']);
  });

  it('classifies broadcast errors', () => {
    expect(classifyBroadcastError(new Error('Failed to fetch'))).toBe('uncertain');
    expect(classifyBroadcastError(new Error('broadcast failed (-26): 18: bad-txns'))).toBe(
      'rejected',
    );
    expect(
      classifyBroadcastError(
        new Error('broadcast failed (-27): transaction already in block chain'),
      ),
    ).toBe('already_known');
  });
});
