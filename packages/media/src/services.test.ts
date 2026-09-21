import { describe, expect, it } from 'vitest';
import { compose, type Service, type ServiceFilter, type TraceEvent } from '@zafu/service';
import {
  callSignalService,
  serviceSignaling,
  signalingStrategy,
  type MediaSignal,
  type Signaling,
} from './signaling';

const ICE: MediaSignal = {
  t: '_ice',
  d: { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0' } },
};

describe('callSignalService', () => {
  it('hands a signal to the Signaling', async () => {
    const sent: MediaSignal[] = [];
    const signaling: Signaling = { send: m => sent.push(m), onSignal: () => () => {} };

    await callSignalService(signaling)(ICE, {});

    expect(sent).toEqual([ICE]);
  });
});

describe('serviceSignaling', () => {
  it('bridges a Service out and a subscriber in', async () => {
    const sent: MediaSignal[] = [];
    const service: Service<MediaSignal, void> = async m => {
      sent.push(m);
    };
    const handlers = new Set<(m: MediaSignal) => void>();
    const signaling = serviceSignaling(service, h => {
      handlers.add(h);
      return () => handlers.delete(h);
    });

    signaling.send(ICE);
    await Promise.resolve(); // the outbound half is fire-and-forget
    expect(sent).toEqual([ICE]);

    const got: MediaSignal[] = [];
    const stop = signaling.onSignal(m => got.push(m));
    handlers.forEach(h => h(ICE));
    expect(got).toEqual([ICE]);

    stop();
    handlers.forEach(h => h(ICE));
    expect(got).toEqual([ICE]); // unsubscribed
  });
});

describe('signalingStrategy', () => {
  it('observes each send', async () => {
    const events: TraceEvent[] = [];
    const service = signalingStrategy('default', { onTrace: e => events.push(e) })(async () => {});

    await service(ICE, {});

    expect(events).toEqual([expect.objectContaining({ ok: true })]);
  });

  it('participates in compose order: the first-listed filter is outermost', async () => {
    const order: string[] = [];
    const marker =
      (name: string): ServiceFilter =>
      inner =>
      async (req, ctx) => {
        order.push(`${name}-in`);
        const res = await inner(req, ctx);
        order.push(`${name}-out`);
        return res;
      };
    const base: Service<MediaSignal, void> = async () => {
      order.push('base');
    };

    await compose(marker('a'), signalingStrategy('default'), marker('b'))(base)(ICE, {});

    expect(order).toEqual(['a-in', 'b-in', 'base', 'b-out', 'a-out']);
  });
});
