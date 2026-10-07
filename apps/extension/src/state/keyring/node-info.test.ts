import { describe, expect, it } from 'vitest';
import { decodeLightdInfo, EMPTY_LIGHTD_INFO } from './lightd-info';
import { describeNode, fullNodeOf, nodeKindOf, nodeLabel, protocolLabel } from './node-info';

const enc = new TextEncoder();
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const str = (field: number, s: string) => {
  const b = enc.encode(s);
  return [...varint(field * 8 + 2), ...varint(b.length), ...b];
};
const num = (field: number, n: number) => [...varint(field * 8), ...varint(n)];

describe('decodeLightdInfo', () => {
  it('reads the fields zafu shows, with blockHeight from field 7 and gitCommit from field 8', () => {
    const buf = new Uint8Array([
      ...str(1, '0.4.18'),
      ...str(2, 'zidecar/rotkonetworks'),
      ...num(3, 1),
      ...str(4, 'main'),
      ...num(5, 419200),
      ...str(6, '37a5165b'),
      ...num(7, 3509311),
      ...str(8, 'v0.10.0-cac9b6748d3f13ba623cf2fc54f05a6dcbbe92d5'),
      ...str(14, '/Zebra:6.4.2/'),
    ]);
    expect(decodeLightdInfo(buf)).toEqual({
      version: '0.4.18',
      vendor: 'zidecar/rotkonetworks',
      chainName: 'main',
      saplingActivationHeight: 419200,
      consensusBranchId: '37a5165b',
      blockHeight: 3509311,
      gitCommit: 'v0.10.0-cac9b6748d3f13ba623cf2fc54f05a6dcbbe92d5',
      zcashdSubversion: '/Zebra:6.4.2/',
    });
  });

  it('skips fields past 15, whose tags are two bytes', () => {
    const buf = new Uint8Array([
      ...str(2, 'ECC LightWalletD'),
      ...str(16, 'NU6.3'),
      ...num(17, 3428143),
      ...str(4, 'main'),
    ]);
    const info = decodeLightdInfo(buf);
    expect(info.vendor).toBe('ECC LightWalletD');
    expect(info.chainName).toBe('main');
  });

  it('keeps what it read before a truncated field', () => {
    const buf = new Uint8Array([...str(2, 'ZingoLabs ZainoD'), 0x22, 0x40, 0x61]);
    expect(decodeLightdInfo(buf)).toEqual({ ...EMPTY_LIGHTD_INFO, vendor: 'ZingoLabs ZainoD' });
  });
});

describe('describeNode', () => {
  it('zidecar: version and commit from gitCommit, link to that commit', () => {
    const n = describeNode(
      {
        vendor: 'zidecar/rotkonetworks',
        version: '0.4.18',
        gitCommit: 'v0.10.0-cac9b6748d3f13ba623cf2fc54f05a6dcbbe92d5',
        zcashdSubversion: '/Zebra:6.4.2/',
      },
      'HTTP/3',
    );
    expect(n).toEqual({
      kind: 'zidecar',
      version: '0.10.0',
      commit: 'cac9b6748d3f13ba623cf2fc54f05a6dcbbe92d5',
      codeUrl:
        'https://github.com/rotkonetworks/zcli/tree/cac9b6748d3f13ba623cf2fc54f05a6dcbbe92d5/bin/zidecar',
      fullNode: 'Zebra 6.4.2',
      protocol: 'HTTP/3',
    });
    expect(nodeLabel(n)).toBe('zidecar · 0.10.0 · cac9b67');
  });

  it('zidecar built without git: links the release tag', () => {
    const n = describeNode({
      vendor: 'zidecar/rotkonetworks',
      version: '0.4.18',
      gitCommit: 'v0.10.0-unknown',
      zcashdSubversion: '',
    });
    expect(n.version).toBe('0.10.0');
    expect(n.commit).toBeUndefined();
    expect(n.codeUrl).toBe('https://github.com/rotkonetworks/zcli/tree/v0.10.0/bin/zidecar');
  });

  it('lightwalletd: version from version, bare commit from gitCommit', () => {
    const n = describeNode({
      vendor: 'ECC LightWalletD',
      version: 'v0.5.4',
      gitCommit: '09593edbee4e',
      zcashdSubversion: '/Zakura:1.6.0/',
    });
    expect(n).toMatchObject({
      kind: 'lightwalletd',
      version: '0.5.4',
      commit: '09593edbee4e',
      codeUrl: 'https://github.com/zcash/lightwalletd/tree/09593edbee4e',
      fullNode: 'Zakura 1.6.0',
    });
  });

  it('zaino is told apart from lightwalletd', () => {
    expect(nodeKindOf('ZingoLabs ZainoD')).toBe('zaino');
    expect(nodeKindOf('ECC LightWalletD')).toBe('lightwalletd');
    expect(nodeKindOf('something else')).toBe('unknown');
    expect(
      describeNode({ vendor: 'nope', version: '', gitCommit: '', zcashdSubversion: '' }),
    ).toEqual({ kind: 'unknown' });
  });
});

describe('labels', () => {
  it('full node names', () => {
    expect(fullNodeOf('/Zebra:6.4.2/')).toBe('Zebra 6.4.2');
    expect(fullNodeOf('/MagicBean:6.0.0/')).toBe('zcashd 6.0.0');
    expect(fullNodeOf('')).toBeUndefined();
  });

  it('protocols', () => {
    expect(protocolLabel('h3')).toBe('HTTP/3');
    expect(protocolLabel('h2')).toBe('HTTP/2');
    expect(protocolLabel('http/1.1')).toBe('HTTP/1.1');
    expect(protocolLabel('')).toBeUndefined();
    expect(protocolLabel(undefined)).toBeUndefined();
  });
});
