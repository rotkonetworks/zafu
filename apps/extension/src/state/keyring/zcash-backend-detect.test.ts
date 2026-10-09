import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backendOfEndpoint,
  classifyLightdInfo,
  createRedetector,
  detectZcashBackend,
  zidecarExtras,
} from './zcash-backend';

/**
 * zcash.rotko.net's real GetLightdInfo answer (zidecar v0.9.0, 2026-10-04),
 * gRPC-framed as it came off the wire: vendor "zidecar/rotkonetworks".
 */
const ROTKO_LIGHTD_INFO =
  '00000000750a06302e342e313812157a6964656361722f726f746b6f6e6574776f726b73180122046d61696e2880cb193208333761353136356238e8ffd501420e76302e392e302d346635363964394a046d61696e5a077a69646563617260e8ffd5016a0676362e342e32720d2f5a656272613a362e342e322f';

const hex = (h: string) => new Uint8Array(h.match(/../g)!.map(b => parseInt(b, 16)));

/** a LightdInfo with only `vendor` (field 2) and `chainName` (field 4), framed */
const lightdInfoWithVendor = (vendor: string) => {
  const enc = new TextEncoder();
  const v = enc.encode(vendor);
  const c = enc.encode('main');
  const msg = new Uint8Array([0x12, v.length, ...v, 0x22, c.length, ...c]);
  return new Uint8Array([0, 0, 0, 0, msg.length, ...msg]);
};

/** a fetch that answers every request with `body`, recording what was asked */
const stubFetch = (body: () => Uint8Array | Promise<never>) => {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(await body(), { status: 200 });
    }),
  );
  return asked;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifying a node from GetLightdInfo', () => {
  it('reads zidecar from its vendor string', () => {
    expect(classifyLightdInfo({ vendor: 'zidecar/rotkonetworks' })).toBe('zidecar');
    expect(classifyLightdInfo({ vendor: '  Zidecar/someone-else ' })).toBe('zidecar');
  });

  it('reads anything else as a standard lightwalletd, the safe kind', () => {
    for (const vendor of [
      'ECC LightWalletD',
      'zaino',
      '',
      'notzidecar',
      'zidecarish',
      'lightwalletd (zidecar compatible)',
    ]) {
      expect(classifyLightdInfo({ vendor })).toBe('lightwalletd');
    }
    expect(classifyLightdInfo({})).toBe('lightwalletd');
    expect(classifyLightdInfo({ vendor: 42 })).toBe('lightwalletd');
  });

  it('detects rotko as zidecar from its real answer', async () => {
    stubFetch(() => hex(ROTKO_LIGHTD_INFO));
    await expect(detectZcashBackend('https://zcash.rotko.net')).resolves.toBe('zidecar');
  });

  it('detects a node that names another vendor as lightwalletd', async () => {
    stubFetch(() => lightdInfoWithVendor('ECC LightWalletD'));
    await expect(detectZcashBackend('https://lwd.example.org')).resolves.toBe('lightwalletd');
  });

  it('throws when the node answers nothing, so the caller keeps what it knew', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(detectZcashBackend('https://lwd.example.org')).rejects.toThrow();
  });
});

describe('asking again after a zidecar call failed', () => {
  it('changes the kind only on an answer, at most once per cooldown', async () => {
    let t = 0;
    const answers: (() => Promise<'zidecar' | 'lightwalletd'>)[] = [
      () => Promise.reject(new Error('blinked')),
      () => Promise.resolve('lightwalletd'),
    ];
    const detect = vi.fn(() => answers.shift()!());
    const redetect = createRedetector(detect, { cooldownMs: 1000, now: () => t });

    // the node blinked: no answer, nothing changes
    await expect(redetect('https://node.example/')).resolves.toBeUndefined();
    // asked again inside the cooldown (same node, other spelling): not asked
    t = 500;
    await expect(redetect('https://NODE.example')).resolves.toBeUndefined();
    expect(detect).toHaveBeenCalledTimes(1);
    // after it: the node answers, and the answer is the new kind
    t = 1500;
    await expect(redetect('https://node.example')).resolves.toBe('lightwalletd');
    expect(detect).toHaveBeenCalledTimes(2);
  });
});

describe('egress: finding out what a node is never fingerprints the wallet', () => {
  it('asks only the chosen node, and only the standard GetLightdInfo', async () => {
    const asked = stubFetch(() => lightdInfoWithVendor('zaino'));
    await detectZcashBackend('https://lwd.example.org');
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(url).toBe(
        'https://lwd.example.org/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo',
      );
      expect(url).not.toContain('zidecar.v1');
    }
  });

  it('falls back to the same standard rpc over grpc-web, never a zidecar one', async () => {
    let n = 0;
    // native gRPC refused (a grpc-web-only proxy), grpc-web answers
    const asked = stubFetch(() =>
      n++ === 0 ? Promise.reject(new Error('415')) : lightdInfoWithVendor('zidecar/rotkonetworks'),
    );
    await expect(detectZcashBackend('https://proxy.example.org')).resolves.toBe('zidecar');
    expect(asked).toHaveLength(2);
    for (const url of asked) {
      expect(url).toMatch(/\/cash\.z\.wallet\.sdk\.rpc\.CompactTxStreamer\/GetLightdInfo$/);
    }
  });

  it('never guesses zidecar for a third-party node before it has answered', () => {
    for (const url of ['https://zec.rocks:443', 'https://lwd.example.org', 'not a url', '']) {
      expect(backendOfEndpoint(url)).toBe('lightwalletd');
      expect(zidecarExtras(url, backendOfEndpoint(url))).toBeUndefined();
    }
    expect(backendOfEndpoint('https://zcash.rotko.net')).toBe('zidecar');
  });
});
