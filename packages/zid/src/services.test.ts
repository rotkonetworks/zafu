import { describe, expect, it, vi } from 'vitest';
import { compose, type Service, type ServiceFilter, type TraceEvent } from '@zafu/service';
import { openXWing, sealXWing, xwingKeypairFromSeed } from '@zafu/pq';
import type { ZafuTransport } from '@zafu/protocol';
import { channelService, sealingFilter, walletService, walletStrategy } from './services';
import type { ZidChannel } from './types';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const PING = { zafu: true as const, version: '1.2.3', protocolVersion: 1 };

/** a transport whose request is the mock, so the service's wiring is observable. */
const transportOf = (request: unknown): ZafuTransport =>
  ({ isAvailable: async () => true, request }) as unknown as ZafuTransport;

describe('walletService', () => {
  it('carries one typed wallet request to the transport', async () => {
    const request = vi.fn(async () => PING);
    const res = await walletService(transportOf(request))({ type: 'ping' }, {});

    expect(request).toHaveBeenCalledWith('ping', { type: 'ping' });
    expect(res).toEqual(PING);
  });

  it('refuses before touching the transport when the context is already aborted', async () => {
    const request = vi.fn();
    const ctrl = new AbortController();
    ctrl.abort(new Error('caller walked away'));

    await expect(
      walletService(transportOf(request))({ type: 'ping' }, { signal: ctrl.signal }),
    ).rejects.toThrow('caller walked away');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('walletStrategy', () => {
  it('observes the call and returns the response unchanged', async () => {
    const events: TraceEvent[] = [];
    const request = vi.fn(async () => PING);
    const service = walletStrategy('default', { onTrace: e => events.push(e) })(
      walletService(transportOf(request)),
    );

    expect(await service({ type: 'ping' }, {})).toEqual(PING);
    expect(events).toEqual([expect.objectContaining({ ok: true })]);
  });

  it('re-issues a failed call (the retry filter is inside the stack)', async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error('flaky');
      }
      return PING;
    });
    const service = walletStrategy('default')(walletService(transportOf(request)));

    expect(await service({ type: 'ping' }, {})).toEqual(PING);
    expect(calls).toBe(2);
  });
});

describe('channelService', () => {
  it('hands the frame to the channel', async () => {
    const sent: Uint8Array[] = [];
    const channel: ZidChannel = {
      peer: 'p',
      send: d => {
        sent.push(typeof d === 'string' ? utf8(d) : d);
      },
      on: () => {},
      close: () => {},
    };

    await channelService(channel)(utf8('frame'), {});

    const frame = sent[0];
    if (!frame) {
      throw new Error('expected the frame to be sent');
    }
    expect(decode(frame)).toBe('frame');
  });
});

describe('sealingFilter', () => {
  const peer = xwingKeypairFromSeed(new Uint8Array(32).fill(1));
  const me = xwingKeypairFromSeed(new Uint8Array(32).fill(2));
  const keys = { recipientPublicKey: peer.publicKey, selfSeed: me.secretKey };

  it('seals the request and opens the response - the inner service sees ciphertext only', async () => {
    let sawRequest: Uint8Array | null = null;
    const inner: Service<Uint8Array, Uint8Array> = async req => {
      sawRequest = req;
      return sealXWing(me.publicKey, utf8('pong'));
    };

    const out = await sealingFilter(keys)(inner)(utf8('ping'), {});

    if (!sawRequest) {
      throw new Error('inner service was not called');
    }
    expect(decode(sawRequest)).not.toBe('ping'); // it was sealed
    expect(decode(openXWing(peer.secretKey, sawRequest))).toBe('ping'); // peer can open it
    expect(decode(out)).toBe('pong'); // and their sealed reply was opened for us
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
    const inner: Service<Uint8Array, Uint8Array> = async () => {
      order.push('base');
      return sealXWing(me.publicKey, new Uint8Array());
    };

    await compose(marker('a'), sealingFilter(keys), marker('b'))(inner)(utf8('x'), {});

    expect(order).toEqual(['a-in', 'b-in', 'base', 'b-out', 'a-out']);
  });
});
