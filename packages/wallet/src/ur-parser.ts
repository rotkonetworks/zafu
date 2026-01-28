/**
 * UR (Uniform Resource) format parser for Zigner QR codes.
 *
 * Supports:
 * - ur:penumbra-accounts - Penumbra Full Viewing Key export
 * - ur:zcash-accounts - Zcash Full Viewing Key export
 *
 * This is a pure browser implementation without Node.js dependencies.
 */

// ============================================================================
// Types
// ============================================================================

export interface PenumbraUrExport {
  walletId: Uint8Array;
  fvk: string;
  accountIndex: number;
  label: string | null;
}

export interface ZcashUrExport {
  ufvk: string;
  accountIndex: number;
  label: string | null;
}

export interface ZignerBackupAccount {
  path: string;
  genesisHash: string | null;
  networkName: string | null;
  encryption: string | null;
  base58prefix: number | null;  // for Substrate networks (SS58 address format)
}

export interface ZignerBackupExport {
  version: number;
  seedName: string;
  accounts: ZignerBackupAccount[];
}

// ============================================================================
// UR Detection
// ============================================================================

/**
 * Check if a string is a UR-encoded string
 */
export function isUrString(text: string): boolean {
  return text.toLowerCase().startsWith('ur:');
}

/**
 * Get the UR type from a UR string
 */
export function getUrType(text: string): string | null {
  if (!isUrString(text)) return null;
  const match = text.match(/^ur:([^/]+)\//i);
  return match ? match[1]!.toLowerCase() : null;
}

// ============================================================================
// Bytewords Decoder (replacement for bc-ur dependency)
// ============================================================================

/**
 * Minimal bytewords mapping from the `ur` Rust crate v0.4.
 * Maps 2-character minimal bytewords to byte values 0-255.
 * This is the exact encoding used by Zigner.
 */
const MINIMAL_BYTEWORDS = [
  'ae', 'ad', 'ao', 'ax', 'aa', 'ah', 'am', 'at', 'ay', 'as', 'bk', 'bd', 'bn', 'bt', 'ba', 'bs', // 0x00-0x0f
  'be', 'by', 'bg', 'bw', 'bb', 'bz', 'cm', 'ch', 'cs', 'cf', 'cy', 'cw', 'ce', 'ca', 'ck', 'ct', // 0x10-0x1f
  'cx', 'cl', 'cp', 'cn', 'dk', 'da', 'ds', 'di', 'de', 'dt', 'dr', 'dn', 'dw', 'dp', 'dm', 'dl', // 0x20-0x2f
  'dy', 'eh', 'ey', 'eo', 'ee', 'ec', 'en', 'em', 'et', 'es', 'ft', 'fr', 'fn', 'fs', 'fm', 'fh', // 0x30-0x3f
  'fz', 'fp', 'fw', 'fx', 'fy', 'fe', 'fg', 'fl', 'fd', 'ga', 'ge', 'gr', 'gs', 'gt', 'gl', 'gw', // 0x40-0x4f
  'gd', 'gy', 'gm', 'gu', 'gh', 'go', 'hf', 'hg', 'hd', 'hk', 'ht', 'hp', 'hh', 'hl', 'hy', 'he', // 0x50-0x5f
  'hn', 'hs', 'id', 'ia', 'ie', 'ih', 'iy', 'io', 'is', 'in', 'im', 'je', 'jz', 'jn', 'jt', 'jl', // 0x60-0x6f
  'jo', 'js', 'jp', 'jk', 'jy', 'kp', 'ko', 'kt', 'ks', 'kk', 'kn', 'kg', 'ke', 'ki', 'kb', 'lb', // 0x70-0x7f
  'la', 'ly', 'lf', 'ls', 'lr', 'lp', 'ln', 'lt', 'lo', 'ld', 'le', 'lu', 'lk', 'lg', 'mn', 'my', // 0x80-0x8f
  'mh', 'me', 'mo', 'mu', 'mw', 'md', 'mt', 'ms', 'mk', 'nl', 'ny', 'nd', 'ns', 'nt', 'nn', 'ne', // 0x90-0x9f
  'nb', 'oy', 'oe', 'ot', 'ox', 'on', 'ol', 'os', 'pd', 'pt', 'pk', 'py', 'ps', 'pm', 'pl', 'pe', // 0xa0-0xaf
  'pf', 'pa', 'pr', 'qd', 'qz', 're', 'rp', 'rl', 'ro', 'rh', 'rd', 'rk', 'rf', 'ry', 'rn', 'rs', // 0xb0-0xbf
  'rt', 'se', 'sa', 'sr', 'ss', 'sk', 'sw', 'st', 'sp', 'so', 'sg', 'sb', 'sf', 'sn', 'to', 'tk', // 0xc0-0xcf
  'ti', 'tt', 'td', 'te', 'ty', 'tl', 'tb', 'ts', 'tp', 'ta', 'tn', 'uy', 'uo', 'ut', 'ue', 'ur', // 0xd0-0xdf
  'vt', 'vy', 'vo', 'vl', 've', 'vw', 'va', 'vd', 'vs', 'wl', 'wd', 'wm', 'wp', 'we', 'wy', 'ws', // 0xe0-0xef
  'wt', 'wn', 'wz', 'wf', 'wk', 'yk', 'yn', 'yl', 'ya', 'yt', 'zs', 'zo', 'zt', 'zc', 'ze', 'zm', // 0xf0-0xff
];

// Build reverse lookup: minimal word -> byte value
const BYTEWORDS_MAP = new Map<string, number>();
MINIMAL_BYTEWORDS.forEach((word, index) => {
  BYTEWORDS_MAP.set(word, index);
});

// Full bytewords list for standard format (4-char words separated by dashes)
const FULL_BYTEWORDS = [
  'able', 'acid', 'also', 'apex', 'aqua', 'arch', 'atom', 'aunt',
  'away', 'axis', 'back', 'bald', 'barn', 'belt', 'beta', 'bias',
  'blue', 'body', 'brag', 'brew', 'bulb', 'buzz', 'calm', 'cash',
  'cats', 'chef', 'city', 'claw', 'code', 'cola', 'cook', 'cost',
  'crux', 'curl', 'cusp', 'cyan', 'dark', 'data', 'days', 'deli',
  'dice', 'diet', 'door', 'down', 'draw', 'drop', 'drum', 'dull',
  'duty', 'each', 'easy', 'echo', 'edge', 'epic', 'even', 'exam',
  'exit', 'eyes', 'fact', 'fair', 'fern', 'figs', 'film', 'fish',
  'fizz', 'flap', 'flew', 'flux', 'foxy', 'free', 'frog', 'fuel',
  'fund', 'gala', 'game', 'gear', 'gems', 'gift', 'girl', 'glow',
  'good', 'gray', 'grim', 'guru', 'gush', 'gyro', 'half', 'hang',
  'hard', 'hawk', 'heat', 'help', 'high', 'hill', 'holy', 'hope',
  'horn', 'huts', 'iced', 'idea', 'idle', 'inch', 'inky', 'into',
  'iris', 'iron', 'item', 'jade', 'jazz', 'join', 'jolt', 'jowl',
  'judo', 'jugs', 'jump', 'junk', 'jury', 'keep', 'keno', 'kept',
  'keys', 'kick', 'kiln', 'king', 'kite', 'kiwi', 'knob', 'lamb',
  'lava', 'lazy', 'leaf', 'legs', 'liar', 'limp', 'lion', 'list',
  'logo', 'loud', 'love', 'luau', 'luck', 'lung', 'main', 'many',
  'math', 'maze', 'memo', 'menu', 'meow', 'mild', 'mint', 'miss',
  'monk', 'nail', 'navy', 'need', 'news', 'next', 'noon', 'note',
  'numb', 'obey', 'oboe', 'omit', 'onyx', 'open', 'oval', 'owls',
  'paid', 'part', 'peck', 'play', 'plus', 'poem', 'pool', 'pose',
  'puff', 'puma', 'purr', 'quad', 'quiz', 'race', 'ramp', 'real',
  'redo', 'rich', 'road', 'rock', 'roof', 'ruby', 'ruin', 'runs',
  'rust', 'safe', 'saga', 'scar', 'sets', 'silk', 'skew', 'slot',
  'soap', 'solo', 'song', 'stub', 'surf', 'swan', 'taco', 'task',
  'taxi', 'tent', 'tied', 'time', 'tiny', 'toil', 'tomb', 'tone',
  'toys', 'trip', 'tuna', 'twin', 'ugly', 'undo', 'unit', 'urge',
  'user', 'vast', 'very', 'veto', 'vial', 'vibe', 'view', 'visa',
  'void', 'vows', 'wall', 'wand', 'warm', 'wasp', 'wave', 'waxy',
  'webs', 'what', 'when', 'whiz', 'wolf', 'work', 'yank', 'yawn',
  'yell', 'yoga', 'yurt', 'zaps', 'zero', 'zest', 'zinc', 'zone', 'zoom',
];

// Add full bytewords to map
FULL_BYTEWORDS.forEach((word, index) => {
  if (index < 256) {
    BYTEWORDS_MAP.set(word, index);
  }
});

/**
 * Decode bytewords string to bytes
 */
function decodeBytewords(encoded: string): Uint8Array {
  const lower = encoded.toLowerCase();
  const bytes: number[] = [];

  // Detect if it's minimal (2-char) or standard (4-char) bytewords
  // Minimal: each word is 2 chars, no separators
  // Standard: each word is 4 chars, optional dashes
  const words = lower.includes('-') ? lower.split('-') : [];

  if (words.length > 0) {
    // Standard format with dashes
    for (const word of words) {
      const value = BYTEWORDS_MAP.get(word);
      if (value === undefined) {
        throw new Error(`bytewords: unknown word "${word}"`);
      }
      bytes.push(value);
    }
  } else {
    // Minimal format - 2 chars per byte
    for (let i = 0; i < lower.length; i += 2) {
      const word = lower.slice(i, i + 2);
      const value = BYTEWORDS_MAP.get(word);
      if (value === undefined) {
        throw new Error(`bytewords: unknown minimal word "${word}"`);
      }
      bytes.push(value);
    }
  }

  // Last 4 bytes are CRC32 checksum - verify and strip
  if (bytes.length < 5) {
    throw new Error('bytewords: too short for checksum');
  }

  const payload = bytes.slice(0, -4);
  const checksumBytes = bytes.slice(-4);
  // Use >>> 0 to ensure unsigned 32-bit integer (JS bitwise ops produce signed ints)
  const expectedChecksum =
    (((checksumBytes[0]! << 24) |
      (checksumBytes[1]! << 16) |
      (checksumBytes[2]! << 8) |
      checksumBytes[3]!) >>> 0);

  const actualChecksum = crc32(new Uint8Array(payload));
  if (actualChecksum !== expectedChecksum) {
    throw new Error('bytewords: checksum mismatch');
  }

  return new Uint8Array(payload);
}

/**
 * CRC32 implementation for bytewords checksum verification
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Decode UR string to CBOR bytes
 */
function decodeUr(urString: string): Uint8Array {
  // Format: ur:type/bytewords
  const match = urString.match(/^ur:([^/]+)\/(.+)$/i);
  if (!match) {
    throw new Error('invalid ur format');
  }
  const bytewordsData = match[2]!;
  return decodeBytewords(bytewordsData);
}

// ============================================================================
// CBOR Parsing Helpers
// ============================================================================

/**
 * Simple CBOR parser for our specific use case.
 * Only handles the subset of CBOR we need for UR decoding.
 */
class CborReader {
  private data: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private readByte(): number {
    if (this.offset >= this.data.length) {
      throw new Error('cbor: unexpected end of data');
    }
    return this.data[this.offset++]!;
  }

  private readBytes(count: number): Uint8Array {
    if (this.offset + count > this.data.length) {
      throw new Error('cbor: unexpected end of data');
    }
    const bytes = this.data.slice(this.offset, this.offset + count);
    this.offset += count;
    return bytes;
  }

  private readLength(additionalInfo: number): number {
    if (additionalInfo < 24) {
      return additionalInfo;
    } else if (additionalInfo === 24) {
      return this.readByte();
    } else if (additionalInfo === 25) {
      const bytes = this.readBytes(2);
      return (bytes[0]! << 8) | bytes[1]!;
    } else if (additionalInfo === 26) {
      const bytes = this.readBytes(4);
      return (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
    }
    throw new Error(`cbor: unsupported length encoding: ${additionalInfo}`);
  }

  readUint(): number {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 0) {
      throw new Error(`cbor: expected uint, got major type ${majorType}`);
    }
    return this.readLength(byte & 0x1f);
  }

  readByteString(): Uint8Array {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 2) {
      throw new Error(`cbor: expected byte string, got major type ${majorType}`);
    }
    const len = this.readLength(byte & 0x1f);
    return this.readBytes(len);
  }

  readTextString(): string {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 3) {
      throw new Error(`cbor: expected text string, got major type ${majorType}`);
    }
    const len = this.readLength(byte & 0x1f);
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }

  readMapHeader(): number {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 5) {
      throw new Error(`cbor: expected map, got major type ${majorType}`);
    }
    return this.readLength(byte & 0x1f);
  }

  readArrayHeader(): number {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 4) {
      throw new Error(`cbor: expected array, got major type ${majorType}`);
    }
    return this.readLength(byte & 0x1f);
  }

  readTag(): number {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 6) {
      throw new Error(`cbor: expected tag, got major type ${majorType}`);
    }
    return this.readLength(byte & 0x1f);
  }

  peekMajorType(): number {
    if (this.offset >= this.data.length) {
      throw new Error('cbor: unexpected end of data');
    }
    return this.data[this.offset]! >> 5;
  }

  hasMore(): boolean {
    return this.offset < this.data.length;
  }
}

// ============================================================================
// Penumbra UR Parsing
// ============================================================================

/**
 * Parse ur:penumbra-accounts UR string
 *
 * CBOR structure:
 * map(2) {
 *   1: bytes(32)  // wallet_id
 *   2: array(1) [  // accounts
 *     tag(49302) map(2-3) {  // PenumbraFullViewingKey
 *       1: text  // fvk (bech32m)
 *       2: uint  // index
 *       3: text  // name (optional)
 *     }
 *   ]
 * }
 */
export function parsePenumbraUr(urString: string): PenumbraUrExport {
  const type = getUrType(urString);
  if (type !== 'penumbra-accounts') {
    throw new Error(`expected ur:penumbra-accounts, got ur:${type}`);
  }

  // Decode UR to CBOR bytes
  const cbor = decodeUr(urString);

  // Parse CBOR
  const reader = new CborReader(cbor);

  // penumbra-accounts may optionally be wrapped in CBOR tag 49301
  // Some implementations include the tag, others don't - handle both
  if (reader.peekMajorType() === 6) {
    reader.readTag(); // Skip the tag
  }

  const mapLen = reader.readMapHeader();
  if (mapLen < 2) {
    throw new Error('penumbra-accounts: expected map with at least 2 entries');
  }

  let walletId: Uint8Array | null = null;
  let fvk: string | null = null;
  let accountIndex = 0;
  let label: string | null = null;

  for (let i = 0; i < mapLen; i++) {
    const key = reader.readUint();
    if (key === 1) {
      // wallet_id
      walletId = reader.readByteString();
    } else if (key === 2) {
      // accounts array
      const accountsLen = reader.readArrayHeader();
      if (accountsLen < 1) {
        throw new Error('penumbra-accounts: expected at least one account');
      }

      // Read first account (tagged PenumbraFullViewingKey)
      const tag = reader.readTag();
      if (tag !== 49302) {
        throw new Error(`penumbra-accounts: expected tag 49302, got ${tag}`);
      }

      const accountMapLen = reader.readMapHeader();
      for (let j = 0; j < accountMapLen; j++) {
        const accountKey = reader.readUint();
        if (accountKey === 1) {
          fvk = reader.readTextString();
        } else if (accountKey === 2) {
          accountIndex = reader.readUint();
        } else if (accountKey === 3) {
          label = reader.readTextString();
        }
      }

      // Skip remaining accounts if any
      for (let k = 1; k < accountsLen; k++) {
        // Skip tagged value by reading through it
        reader.readTag();
        const skipMapLen = reader.readMapHeader();
        for (let l = 0; l < skipMapLen; l++) {
          reader.readUint(); // key
          if (reader.peekMajorType() === 3) {
            reader.readTextString();
          } else {
            reader.readUint();
          }
        }
      }
    }
  }

  if (!walletId) {
    throw new Error('penumbra-accounts: missing wallet_id');
  }
  if (!fvk) {
    throw new Error('penumbra-accounts: missing fvk');
  }

  return { walletId, fvk, accountIndex, label };
}

// ============================================================================
// Zcash UR Parsing
// ============================================================================

/**
 * Parse ur:zcash-accounts UR string
 *
 * CBOR structure (Keystone SDK compatible):
 * map(2) {
 *   1: bytes(16)  // seed_fingerprint
 *   2: array(n) [  // accounts
 *     map(2-3) {
 *       1: text  // ufvk
 *       2: uint  // key_source (should be 0 for zip32)
 *       3: text  // name (optional)
 *     }
 *   ]
 * }
 */
export function parseZcashUr(urString: string): ZcashUrExport {
  const type = getUrType(urString);
  if (type !== 'zcash-accounts') {
    throw new Error(`expected ur:zcash-accounts, got ur:${type}`);
  }

  // Decode UR to CBOR bytes
  const cbor = decodeUr(urString);

  // Parse CBOR
  const reader = new CborReader(cbor);

  // zcash-accounts may optionally be wrapped in CBOR tag 49201
  // Some implementations include the tag, others don't - handle both
  if (reader.peekMajorType() === 6) {
    reader.readTag(); // Skip the tag (don't validate - different implementations use different tags)
  }

  const mapLen = reader.readMapHeader();

  let ufvk: string | null = null;
  let accountIndex = 0;
  let label: string | null = null;

  for (let i = 0; i < mapLen; i++) {
    const key = reader.readUint();
    if (key === 1) {
      // seed_fingerprint - skip it
      reader.readByteString();
    } else if (key === 2) {
      // accounts array
      const accountsLen = reader.readArrayHeader();
      if (accountsLen < 1) {
        throw new Error('zcash-accounts: expected at least one account');
      }

      // Read first account (may be tagged with CBOR tag 49203)
      if (reader.peekMajorType() === 6) {
        reader.readTag(); // Skip the ZcashUnifiedFullViewingKey tag
      }
      const accountMapLen = reader.readMapHeader();
      for (let j = 0; j < accountMapLen; j++) {
        const accountKey = reader.readUint();
        if (accountKey === 1) {
          ufvk = reader.readTextString();
        } else if (accountKey === 2) {
          accountIndex = reader.readUint();
        } else if (accountKey === 3) {
          label = reader.readTextString();
        }
      }
    }
  }

  if (!ufvk) {
    throw new Error('zcash-accounts: missing ufvk');
  }

  return { ufvk, accountIndex, label };
}

// ============================================================================
// Zigner Backup UR Parsing
// ============================================================================

/**
 * Parse ur:zigner-backup UR string
 *
 * The zigner-backup format contains JSON data with:
 * - v: version number (2)
 * - name: seed name
 * - accounts: array of account derivations with path, genesis_hash, network, encryption
 *
 * CBOR structure:
 * text string containing JSON
 */
export function parseZignerBackupUr(urString: string): ZignerBackupExport {
  const type = getUrType(urString);
  if (type !== 'zigner-backup') {
    throw new Error(`expected ur:zigner-backup, got ur:${type}`);
  }

  // Decode UR to CBOR bytes
  const cbor = decodeUr(urString);

  // Parse CBOR - zigner-backup is just a text string containing JSON
  const reader = new CborReader(cbor);
  const jsonString = reader.readTextString();

  // Parse the JSON
  let parsed: {
    v?: number;
    name?: string;
    accounts?: Array<{
      path?: string;
      genesis_hash?: string;
      network?: string;
      encryption?: string;
      base58prefix?: number;
    }>;
  };

  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('zigner-backup: invalid JSON in payload');
  }

  const version = parsed.v ?? 1;
  const seedName = parsed.name;
  const accounts = parsed.accounts;

  if (!seedName) {
    throw new Error('zigner-backup: missing seed name');
  }

  if (!accounts || !Array.isArray(accounts)) {
    throw new Error('zigner-backup: missing or invalid accounts array');
  }

  const mappedAccounts: ZignerBackupAccount[] = accounts.map((acc) => ({
    path: acc.path ?? '',
    genesisHash: acc.genesis_hash ?? null,
    networkName: acc.network ?? null,
    encryption: acc.encryption ?? null,
    base58prefix: typeof acc.base58prefix === 'number' ? acc.base58prefix : null,
  }));

  return {
    version,
    seedName,
    accounts: mappedAccounts,
  };
}
