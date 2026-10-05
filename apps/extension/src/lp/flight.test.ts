import { describe, expect, it } from 'vitest';
import {
  advance,
  isDone,
  isFlight,
  needs,
  resumed,
  sending,
  sent,
  shieldRefund,
  startFlight,
  stepLines,
  stopped,
  type Flight,
} from './flight';
import { ADD_MEMO, withdrawMemo, zecText } from './math';

const T = { zec: zecText, address: 't1Lq8…3vNe', pocket: 'main pocket' };
const roundTrip = (f: Flight): Flight => JSON.parse(JSON.stringify(f)) as Flight;

describe('an add in flight', () => {
  const start = () =>
    startFlight('add', 1_000_000n, ADD_MEMO, { unitsBefore: '0', fundZat: '1015000' }, 1000);

  it('walks fund, settle, send, seen, credit, credited', () => {
    let f = start();
    expect(needs(f)).toBe('fund');
    f = sent(sending(f), 'aa11');
    expect(f.stage).toBe('settle');
    expect(f.fundTxid).toBe('aa11');
    // the shield-out isn't mined: nothing moves
    expect(advance(f, { short: 1_000n })).toBe(f);
    f = advance(f, { short: 0n });
    expect(f.stage).toBe('send');
    expect(needs(f)).toBe('send');
    f = sent(sending(f), 'bb22');
    expect(f.stage).toBe('seen');
    expect(needs(f)).toBeUndefined();
    f = advance(f, { seen: { observed: true, finalised: false } });
    expect(f.stage).toBe('credit');
    // finalised, but the units haven't moved yet: wait
    expect(advance(f, { seen: { observed: true, finalised: true }, units: 0n }).stage).toBe('credit');
    f = advance(f, { seen: { observed: true, finalised: true }, units: 836_120_000n });
    expect(f.stage).toBe('credited');
    expect(isDone(f)).toBe(true);
  });

  it('skips the shield-out when the lp address already holds enough', () => {
    const f = sent(sending(start()), undefined);
    expect(f.stage).toBe('send');
    expect(f.fundTxid).toBeUndefined();
  });

  it('turns to refunded with the amount and reason when thorchain sends it back', () => {
    let f = sent(sending(advance(sent(sending(start()), 'aa'), { short: 0n })), 'bb');
    f = advance(f, {
      seen: { observed: true, finalised: true, out: { zat: 955_000n, refund: true, txid: 'cc' } },
      refundReason: 'adds were paused when it arrived',
    });
    expect(f.stage).toBe('refunded');
    expect(f.outZat).toBe('955000');
    expect(f.reason).toBe('adds were paused when it arrived');
    expect(isDone(f)).toBe(false);
    // the person chooses: shield it back
    f = shieldRefund(f);
    expect(needs(f)).toBe('shield');
    f = sent(sending(f), 'dd');
    expect(f.stage).toBe('shielded');
    expect(isDone(f)).toBe(true);
    expect(stepLines(f, T).map(l => l.t)).toContain('thorchain returned it');
  });
});

describe('a take-out in flight', () => {
  const start = () =>
    startFlight('withdraw', 15_000n, withdrawMemo(10_000), { bps: 10_000, expectZat: '964000' }, 1000);

  it('walks fund, ask, payout, arrive, shield', () => {
    let f = sent(sending(start()), 'f1');
    f = advance(f, { short: 0n });
    expect(f.stage).toBe('ask');
    f = sent(sending(f), 'a1');
    expect(f.stage).toBe('payout');
    // planned but not yet sent: wait for the outbound's own txid
    expect(
      advance(f, { seen: { observed: true, finalised: true, out: { zat: 919_000n, refund: false } } })
        .stage,
    ).toBe('payout');
    f = advance(f, {
      seen: { observed: true, finalised: true, out: { zat: 919_000n, refund: false, txid: 'o1' } },
    });
    expect(f.stage).toBe('arrive');
    expect(advance(f, { utxoZat: [15_000n] }).stage).toBe('arrive');
    f = advance(f, { utxoZat: [919_000n] });
    expect(f.stage).toBe('shield');
    expect(needs(f)).toBe('shield');
    f = sent(sending(f), 's1');
    expect(isDone(f)).toBe(true);
    expect(stepLines(f, T).every(l => l.state === 'done')).toBe(true);
  });

  it('stops as refused with thorchain\'s reason, nothing more to send', () => {
    const f = advance(sent(sending(advance(sent(sending(start()), 'f'), { short: 0n })), 'a'), {
      refundReason: 'withdraw locked up',
    });
    expect(f.stage).toBe('refused');
    expect(isDone(f)).toBe(true);
    expect(needs(f)).toBeUndefined();
  });
});

describe('persist and resume', () => {
  it('survives json, and a resumed record carries on from its stage', () => {
    const f = roundTrip(advance(sent(sending(startFlight('add', 1n, ADD_MEMO)), 'x'), { short: 0n }));
    expect(isFlight(f)).toBe(true);
    expect(resumed(f)).toBe(f);
    expect(needs(resumed(f))).toBe('send');
  });

  it('never sends twice: a send marked out with no txid stops and asks', () => {
    const f = roundTrip(sending(advance(sent(sending(startFlight('add', 1n, ADD_MEMO)), 'x'), { short: 0n })));
    // the tab closed mid-send: the record says a send was out
    expect(needs(f)).toBeUndefined();
    const r = resumed(f);
    expect(r.error).toMatch(/may already have gone out/);
    expect(needs(r)).toBeUndefined();
    expect(advance(r, { short: 0n })).toBe(r);
  });

  it('a stopped step waits for the person, then runs again', () => {
    const f = stopped(sending(startFlight('add', 1n, ADD_MEMO)), 'thorchain has paused adds');
    expect(needs(f)).toBeUndefined();
    expect(needs({ ...f, error: undefined })).toBe('fund');
  });

  it('refuses shapes it did not write', () => {
    expect(isFlight(null)).toBe(false);
    expect(isFlight({ v: 2 })).toBe(false);
    expect(isFlight({ ...startFlight('add', 1n, ADD_MEMO), stage: 'nope' })).toBe(false);
  });
});

describe('the tracker lines', () => {
  it('marks done, now and later in order, stamping finished steps', () => {
    let f = startFlight('add', 1_000_000n, ADD_MEMO, { fundZat: '1015000' }, 1000);
    f = sent(sending(f), 'aa');
    const lines = stepLines(f, T);
    expect(lines.map(l => l.state)).toEqual(['done', 'now', 'later', 'later', 'later']);
    expect(lines[0]!.at).toBe(f.at.settle);
    expect(lines[2]!.d).toBe('memo +:ZEC.ZEC · 0.0100 zec');
  });
});
