import {
  readBytes,
  readTag,
  readVarintNumber,
  skipValue,
  WIRE_LEN,
  WIRE_VARINT,
} from '../../net/proto-reader';

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
    const tag = readTag(buf, pos);
    if (!tag) {
      break;
    }
    const { field, wire } = tag;
    if (wire === WIRE_VARINT) {
      const v = readVarintNumber(buf, tag.next);
      if (!v) {
        break;
      }
      if (field === 5) {
        info.saplingActivationHeight = v[0];
      } else if (field === 7) {
        info.blockHeight = v[0];
      }
      pos = v[1];
    } else if (wire === WIRE_LEN) {
      const v = readBytes(buf, tag.next);
      if (!v) {
        break;
      }
      const name = LIGHTD_INFO_STRINGS[field];
      if (name) {
        info[name] = decoder.decode(v[0]);
      }
      pos = v[1];
    } else {
      const next = skipValue(buf, tag.next, wire);
      if (next === undefined) {
        break;
      }
      pos = next;
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
