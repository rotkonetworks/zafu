/**
 * LightdInfo, the answer to the standard GetLightdInfo (lightwalletd
 * service.proto). Every zcash light server speaks it - lightwalletd, Zaino and
 * zidecar alike - so it is how zafu learns what a node is without asking it
 * anything a stock lightwalletd would not be asked.
 */
export interface LightdInfo {
  /** field 1. zidecar fills this with a lightwalletd-compatible number, not its own version */
  version: string;
  /** field 2: "zidecar/rotkonetworks", "ECC LightWalletD", "ZingoLabs ZainoD", ... */
  vendor: string;
  /** field 4: "main" / "test" */
  chainName: string;
  /** field 5 */
  saplingActivationHeight: number;
  /** field 6: hex, no 0x */
  consensusBranchId: string;
  /** field 7 */
  blockHeight: number;
  /** field 8: zidecar sends "v<version>-<commit>" */
  gitCommit: string;
  /** field 14: the full node behind it, e.g. "/Zebra:6.4.2/" */
  zcashdSubversion: string;
}

export const EMPTY_LIGHTD_INFO: Readonly<LightdInfo> = {
  version: '',
  vendor: '',
  chainName: '',
  saplingActivationHeight: 0,
  consensusBranchId: '',
  blockHeight: 0,
  gitCommit: '',
  zcashdSubversion: '',
};

/** an unsigned varint at `pos`: [value, next pos], or undefined if cut short or past 2^53 */
const varint = (buf: Uint8Array, pos: number): [number, number] | undefined => {
  let v = 0;
  for (let i = 0; i < 8 && pos < buf.length; i++) {
    const b = buf[pos++]!;
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) {
      return Number.isSafeInteger(v) ? [v, pos] : undefined;
    }
  }
  return undefined;
};

/**
 * Decode a LightdInfo message. Tags are varints (newer lightwalletd sends
 * fields past 15), unknown fields are skipped, and a malformed message yields
 * what was read before the damage rather than throwing.
 */
export const decodeLightdInfo = (buf: Uint8Array): LightdInfo => {
  const info: LightdInfo = { ...EMPTY_LIGHTD_INFO };
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos < buf.length) {
    const tag = varint(buf, pos);
    if (!tag) {
      break;
    }
    const [key, afterTag] = tag;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    pos = afterTag;
    if (wire === 0) {
      const v = varint(buf, pos);
      if (!v) {
        break;
      }
      if (field === 5) {
        info.saplingActivationHeight = v[0];
      } else if (field === 7) {
        info.blockHeight = v[0];
      }
      pos = v[1];
    } else if (wire === 2) {
      const len = varint(buf, pos);
      if (!len || len[1] + len[0] > buf.length) {
        break;
      }
      const name = LIGHTD_INFO_STRINGS[field];
      if (name) {
        info[name] = decoder.decode(buf.subarray(len[1], len[1] + len[0]));
      }
      pos = len[1] + len[0];
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return info;
};

/** the length-delimited (string) fields, by field number */
export const LIGHTD_INFO_STRINGS: Partial<
  Record<
    number,
    'version' | 'vendor' | 'chainName' | 'consensusBranchId' | 'gitCommit' | 'zcashdSubversion'
  >
> = {
  1: 'version',
  2: 'vendor',
  4: 'chainName',
  6: 'consensusBranchId',
  8: 'gitCommit',
  14: 'zcashdSubversion',
};
