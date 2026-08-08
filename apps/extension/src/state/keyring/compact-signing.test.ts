import { describe, it, expect, vi } from 'vitest';
import {
  parseCompactResponse,
  buildCompactRequest,
  mergeContributions,
  POOL_ORCHARD,
  POOL_IRONWOOD,
} from './compact-signing';

describe('compact-signing', () => {
  // ============================================================================
  // buildCompactRequest tests
  // ============================================================================

  describe('buildCompactRequest', () => {
    it('builds a single compact request with prelude', () => {
      const pcztHex = '50435a5403' + '00'; // "PCZT\x03" + null byte
      const result = buildCompactRequest([pcztHex]);

      expect(result[0]).toBe(0x53); // prelude
      expect(result[1]).toBe(0x04); // crypto type
      expect(result[2]).toBe(0x05); // single compact
      expect(result.slice(3)).toEqual(new Uint8Array([0x50, 0x43, 0x5a, 0x54, 0x03, 0x00]));
    });

    it('builds a batch compact request with prelude', () => {
      const pczt1 = '0102'; // 2 bytes
      const pczt2 = '030405'; // 3 bytes
      const result = buildCompactRequest([pczt1, pczt2]);

      expect(result[0]).toBe(0x53); // prelude
      expect(result[1]).toBe(0x04); // crypto type
      expect(result[2]).toBe(0x06); // batch compact
      expect(result[3]).toBe(2); // count

      // First message: id_len=0, pczt_len=2 (LE), pczt_bytes
      expect(result[4]).toBe(0); // id_len
      expect(result[5]).toBe(2); // pczt_len low byte (LE)
      expect(result[6]).toBe(0); // pczt_len byte 2
      expect(result[7]).toBe(0); // pczt_len byte 3
      expect(result[8]).toBe(0); // pczt_len byte 4
      expect(result[9]).toBe(0x01); // pczt data
      expect(result[10]).toBe(0x02); // pczt data

      // Second message: id_len=0, pczt_len=3 (LE), pczt_bytes
      expect(result[11]).toBe(0); // id_len
      expect(result[12]).toBe(3); // pczt_len low byte
      expect(result[13]).toBe(0); // pczt_len byte 2
      expect(result[14]).toBe(0); // pczt_len byte 3
      expect(result[15]).toBe(0); // pczt_len byte 4
      expect(result[16]).toBe(0x03); // pczt data
      expect(result[17]).toBe(0x04); // pczt data
      expect(result[18]).toBe(0x05); // pczt data
    });

    it('throws on empty array', () => {
      expect(() => buildCompactRequest([])).toThrow('at least one PCZT required');
    });

    it('throws on batch size exceeding max (40)', () => {
      const pczts = Array(41).fill('0102');
      expect(() => buildCompactRequest(pczts)).toThrow('batch size 41 exceeds max 40');
    });

    it('allows batch size exactly at max (40)', () => {
      const pczts = Array(40).fill('0102');
      const result = buildCompactRequest(pczts);
      expect(result[2]).toBe(0x06); // batch compact
      expect(result[3]).toBe(40); // count
    });
  });

  // ============================================================================
  // parseCompactResponse tests
  // ============================================================================

  describe('parseCompactResponse', () => {
    it('parses single compact response (0x07)', () => {
      // Build: [0x53][0x04][0x07] || ver_len:1 || "1" || sig_count:2 ||
      //        (pool, action_idx, sig)* 2
      const sig1 = new Uint8Array(64).fill(0xaa);
      const sig2 = new Uint8Array(64).fill(0xbb);

      const buf: number[] = [
        0x53,
        0x04,
        0x07, // prelude
        0x01, // version length
        0x31, // "1"
        0x02,
        0x00, // sig_count = 2 (LE)
        POOL_ORCHARD,
        0x00,
        0x00,
        0x00,
        0x00, // action_index = 0
      ];
      buf.push(...sig1);
      buf.push(POOL_IRONWOOD, 0x01, 0x00, 0x00, 0x00); // action_index = 1
      buf.push(...sig2);

      const result = parseCompactResponse(new Uint8Array(buf));

      expect(result.version).toBe('1');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.pcztIndex).toBe(0);
      expect(result.messages[0]!.signatures).toHaveLength(2);

      expect(result.messages[0]!.signatures[0]!.pool).toBe(POOL_ORCHARD);
      expect(result.messages[0]!.signatures[0]!.actionIndex).toBe(0);
      expect(result.messages[0]!.signatures[0]!.signature).toEqual(sig1);

      expect(result.messages[0]!.signatures[1]!.pool).toBe(POOL_IRONWOOD);
      expect(result.messages[0]!.signatures[1]!.actionIndex).toBe(1);
      expect(result.messages[0]!.signatures[1]!.signature).toEqual(sig2);
    });

    it('decodes a high-byte (>= 0x80) action_index as a positive number, not negative', () => {
      // action_index = 0x80000001 (top byte 0x80 would sign-extend under a
      // naive `<< 24` decoder, producing a negative JS number).
      const sig = new Uint8Array(64).fill(0xcc);
      const buf: number[] = [
        0x53,
        0x04,
        0x07, // prelude
        0x01,
        0x31, // version "1"
        0x01,
        0x00, // sig_count = 1
        POOL_ORCHARD,
        0x01,
        0x00,
        0x00,
        0x80, // action_index = 0x80000001 LE
      ];
      buf.push(...sig);

      const result = parseCompactResponse(new Uint8Array(buf));
      const actionIndex = result.messages[0]!.signatures[0]!.actionIndex;

      expect(actionIndex).toBe(0x80000001);
      expect(actionIndex).toBeGreaterThan(0);
      expect(Number.isSafeInteger(actionIndex)).toBe(true);
    });

    it('parses batch compact response (0x08)', () => {
      // Build: [0x53][0x04][0x08] || ver_len || "1" || count:2 ||
      //        (id_len:0, sig_count:1, sig)*2
      const sig1 = new Uint8Array(64).fill(0xaa);
      const sig2 = new Uint8Array(64).fill(0xbb);

      const buf: number[] = [
        0x53,
        0x04,
        0x08, // prelude
        0x01, // version length
        0x31, // "1"
        0x02, // count = 2
        // First message
        0x00, // id_len = 0
        0x01,
        0x00, // sig_count = 1
        POOL_ORCHARD,
        0x00,
        0x00,
        0x00,
        0x00, // action_index = 0
      ];
      buf.push(...sig1);
      buf.push(
        // Second message
        0x00, // id_len = 0
        0x01,
        0x00, // sig_count = 1
        POOL_IRONWOOD,
        0x01,
        0x00,
        0x00,
        0x00, // action_index = 1
      );
      buf.push(...sig2);

      const result = parseCompactResponse(new Uint8Array(buf));

      expect(result.version).toBe('1');
      expect(result.messages).toHaveLength(2);

      expect(result.messages[0]!.pcztIndex).toBe(0);
      expect(result.messages[0]!.signatures).toHaveLength(1);
      expect(result.messages[0]!.signatures[0]!.pool).toBe(POOL_ORCHARD);
      expect(result.messages[0]!.signatures[0]!.actionIndex).toBe(0);

      expect(result.messages[1]!.pcztIndex).toBe(1);
      expect(result.messages[1]!.signatures).toHaveLength(1);
      expect(result.messages[1]!.signatures[0]!.pool).toBe(POOL_IRONWOOD);
      expect(result.messages[1]!.signatures[0]!.actionIndex).toBe(1);
    });

    it('captures the echoed id per batch message', () => {
      const sig = new Uint8Array(64).fill(0xaa);
      const buf: number[] = [
        0x53,
        0x04,
        0x08, // prelude, batch response
        0x01,
        0x31, // version
        0x01, // count = 1
        0x03, // id_len = 3
        0x61,
        0x62,
        0x63, // id = "abc"
        0x01,
        0x00, // sig_count = 1
        POOL_ORCHARD,
        0x00,
        0x00,
        0x00,
        0x00, // action_index = 0
      ];
      buf.push(...sig);

      const result = parseCompactResponse(new Uint8Array(buf));
      expect(result.messages[0]!.id).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
    });

    it('single response messages carry an empty id', () => {
      const sig = new Uint8Array(64).fill(0xaa);
      const buf: number[] = [
        0x53,
        0x04,
        0x07,
        0x01,
        0x31,
        0x01,
        0x00,
        POOL_ORCHARD,
        0x00,
        0x00,
        0x00,
        0x00,
      ];
      buf.push(...sig);

      const result = parseCompactResponse(new Uint8Array(buf));
      expect(result.messages[0]!.id).toEqual(new Uint8Array(0));
    });

    it('captures the version prefix for a non-"1" version string', () => {
      const buf: number[] = [
        0x53,
        0x04,
        0x07,
        0x01,
        0x32, // version "2"
        0x00,
        0x00, // sig_count = 0
      ];
      const result = parseCompactResponse(new Uint8Array(buf));
      expect(result.version).toBe('2');
    });

    it('throws on wrong prelude', () => {
      const buf = new Uint8Array([0x54, 0x04, 0x07, 0x01, 0x31, 0x00, 0x00]);
      expect(() => parseCompactResponse(buf)).toThrow('expected prelude 0x53');
    });

    it('throws on wrong crypto type', () => {
      const buf = new Uint8Array([0x53, 0x05, 0x07, 0x01, 0x31, 0x00, 0x00]);
      expect(() => parseCompactResponse(buf)).toThrow('expected crypto type 0x04');
    });

    it('throws on unknown tx_type', () => {
      const buf = new Uint8Array([0x53, 0x04, 0x09, 0x01, 0x31, 0x00, 0x00]);
      expect(() => parseCompactResponse(buf)).toThrow('unknown compact response tx_type');
    });

    it('throws on truncated version', () => {
      const buf = new Uint8Array([0x53, 0x04, 0x07, 0x05]); // version len 5 but only 4 bytes total
      expect(() => parseCompactResponse(buf)).toThrow('truncated at version');
    });

    it('throws on truncated signature count', () => {
      const buf = new Uint8Array([0x53, 0x04, 0x07, 0x01, 0x31]); // missing sig count bytes
      expect(() => parseCompactResponse(buf)).toThrow('truncated at signature count');
    });

    it('throws on truncated signature data', () => {
      const buf = new Uint8Array([
        0x53,
        0x04,
        0x07, // prelude
        0x01,
        0x31, // version
        0x02,
        0x00, // sig_count = 2
        POOL_ORCHARD,
        0x00,
        0x00,
        0x00,
        0x00, // first sig - action_index but incomplete
      ]);
      expect(() => parseCompactResponse(buf)).toThrow('truncated at signature 0');
    });

    it('throws on invalid pool value', () => {
      const buf: number[] = [
        0x53,
        0x04,
        0x07, // prelude
        0x01,
        0x31, // version
        0x01,
        0x00, // sig_count = 1
        0x99, // invalid pool
        0x00,
        0x00,
        0x00,
        0x00, // action_index
      ];
      buf.push(...new Array(64).fill(0xaa)); // signature
      expect(() => parseCompactResponse(new Uint8Array(buf))).toThrow('unknown pool value');
    });

    it('throws on too short buffer', () => {
      expect(() => parseCompactResponse(new Uint8Array([0x53, 0x04]))).toThrow(
        'compact response too short',
      );
    });

    it('throws on invalid batch count (0)', () => {
      const buf = new Uint8Array([
        0x53,
        0x04,
        0x08, // prelude
        0x01,
        0x31, // version
        0x00, // count = 0
      ]);
      expect(() => parseCompactResponse(buf)).toThrow('invalid batch count');
    });

    it('throws on invalid batch count (>40)', () => {
      const buf = new Uint8Array([
        0x53,
        0x04,
        0x08, // prelude
        0x01,
        0x31, // version
        0x29, // count = 41
      ]);
      expect(() => parseCompactResponse(buf)).toThrow('invalid batch count');
    });
  });

  // ============================================================================
  // Round-trip tests
  // ============================================================================

  describe('round-trip', () => {
    it('round-trips single compact request', () => {
      const pcztHex = '50435a5403'; // "PCZT\x03"
      const request = buildCompactRequest([pcztHex]);

      // Verify structure
      expect(request[0]).toBe(0x53);
      expect(request[1]).toBe(0x04);
      expect(request[2]).toBe(0x05);
      expect(Array.from(request.slice(3))).toEqual([0x50, 0x43, 0x5a, 0x54, 0x03]);
    });

    it('round-trips batch compact request with 2 PCZTs', () => {
      const pczts = ['0102', '030405'];
      const request = buildCompactRequest(pczts);

      // Verify prelude and batch structure
      expect(request[0]).toBe(0x53);
      expect(request[1]).toBe(0x04);
      expect(request[2]).toBe(0x06);
      expect(request[3]).toBe(2);

      // Verify each message is properly encoded
      let pos = 4;
      for (const pcztHex of pczts) {
        const expectedLen = pcztHex.length / 2;
        expect(request[pos]).toBe(0); // id_len
        pos += 1;
        expect(request[pos]).toBe(expectedLen); // pczt_len
        pos += 4;
        pos += expectedLen;
      }
    });
  });

  // ============================================================================
  // mergeContributions tests
  // ============================================================================

  describe('mergeContributions', () => {
    it('calls wasm function with correct arguments', async () => {
      const original = ['aabbccdd'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [
            {
              pool: POOL_ORCHARD,
              actionIndex: 0,
              signature: new Uint8Array(64).fill(0x42),
            },
          ],
        },
      ];

      const mockWasm = vi.fn(() => 'eeff00ff');
      const result = await mergeContributions(original, parsed, mockWasm);

      expect(mockWasm).toHaveBeenCalledTimes(1);
      expect(mockWasm).toHaveBeenCalledWith('aabbccdd', expect.stringContaining('"contributions"'));
      expect(result).toEqual(['eeff00ff']);
    });

    it('merges multiple PCZTs', async () => {
      const original = ['aa', 'bb', 'cc'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
        {
          pcztIndex: 1,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_IRONWOOD, actionIndex: 1, signature: new Uint8Array(64) }],
        },
        {
          pcztIndex: 2,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
      ];

      const mockWasm = vi.fn(hex => `updated_${hex}`);
      const result = await mergeContributions(original, parsed, mockWasm);

      expect(mockWasm).toHaveBeenCalledTimes(3);
      expect(result).toEqual(['updated_aa', 'updated_bb', 'updated_cc']);
    });

    it('throws when a requested PCZT has no signature message at all (fails closed)', async () => {
      const original = ['aa', 'bb'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
        // No message for PCZT 1
      ];

      const mockWasm = vi.fn(hex => `updated_${hex}`);
      // Message-count mismatch (1 message vs 2 PCZTs sent) is caught before
      // per-PCZT lookup even runs.
      await expect(mergeContributions(original, parsed, mockWasm)).rejects.toThrow(
        'compact response carries 1 message(s) but 2 PCZT(s) were sent',
      );
    });

    it('throws on an empty signature set for a requested PCZT (fails closed, was: silent pass-through)', async () => {
      const original = ['aa', 'bb'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
        {
          pcztIndex: 1,
          id: new Uint8Array(0),
          signatures: [], // device claims nothing to contribute - must not merge as "unsigned but fine"
        },
      ];

      const mockWasm = vi.fn(hex => `updated_${hex}`);
      await expect(mergeContributions(original, parsed, mockWasm)).rejects.toThrow(
        'compact response contains zero signatures for PCZT 1',
      );
    });

    it('throws when the message count does not match the number of PCZTs sent', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
        {
          pcztIndex: 1,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
      ];

      const mockWasm = vi.fn(hex => `updated_${hex}`);
      await expect(mergeContributions(original, parsed, mockWasm)).rejects.toThrow(
        'compact response carries 2 message(s) but 1 PCZT(s) were sent',
      );
    });

    it('throws on wasm failure', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
      ];

      const mockWasm = vi.fn(() => {
        throw new Error('wasm crash');
      });

      await expect(mergeContributions(original, parsed, mockWasm)).rejects.toThrow(
        'failed to apply signatures to PCZT 0: wasm crash',
      );
    });

    it('passes correct JSON structure to wasm', async () => {
      const original = ['aa'];
      const sig = new Uint8Array(64);
      sig[0] = 0x42;
      sig[63] = 0x99;

      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [
            {
              pool: POOL_IRONWOOD,
              actionIndex: 42,
              signature: sig,
            },
          ],
        },
      ];

      let capturedJson = '';
      const mockWasm = vi.fn((hex, json) => {
        capturedJson = json;
        return 'updated';
      });

      await mergeContributions(original, parsed, mockWasm);

      const parsed_json = JSON.parse(capturedJson);
      expect(parsed_json.contributions).toHaveLength(1);
      expect(parsed_json.contributions[0]!.pool).toBe(POOL_IRONWOOD);
      expect(parsed_json.contributions[0]!.action_index).toBe(42);
      expect(parsed_json.contributions[0]!.signature).toEqual(Array.from(sig));
    });

    it('throws on an id mismatch when the caller supplied expected ids', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array([0x61, 0x62]), // "ab"
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      await expect(
        mergeContributions(original, parsed, mockWasm, {
          expectedIds: [new Uint8Array([0x78, 0x79])], // "xy" - does not match echoed "ab"
        }),
      ).rejects.toThrow('compact response id mismatch for PCZT 0');
    });

    it('accepts a matching id when the caller supplied expected ids', async () => {
      const original = ['aa'];
      const id = new Uint8Array([0x61, 0x62]);
      const parsed = [
        {
          pcztIndex: 0,
          id,
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 0, signature: new Uint8Array(64) }],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      const result = await mergeContributions(original, parsed, mockWasm, { expectedIds: [id] });
      expect(result).toEqual(['updated_aa']);
    });

    it('throws on duplicate (pool, action_index) pairs within a message', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [
            { pool: POOL_ORCHARD, actionIndex: 2, signature: new Uint8Array(64) },
            { pool: POOL_ORCHARD, actionIndex: 2, signature: new Uint8Array(64) },
          ],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      await expect(mergeContributions(original, parsed, mockWasm)).rejects.toThrow(
        'compact response has duplicate signature for pool 0 action 2 in PCZT 0',
      );
    });

    it('allows the same action_index across different pools (not a duplicate)', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [
            { pool: POOL_ORCHARD, actionIndex: 2, signature: new Uint8Array(64) },
            { pool: POOL_IRONWOOD, actionIndex: 2, signature: new Uint8Array(64) },
          ],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      await expect(mergeContributions(original, parsed, mockWasm)).resolves.toBeDefined();
    });

    it('throws on an action_index out of range when actionCounts is known', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 5, signature: new Uint8Array(64) }],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      await expect(
        mergeContributions(original, parsed, mockWasm, { actionCounts: [3] }),
      ).rejects.toThrow('compact response action_index 5 out of range [0, 3) for PCZT 0');
    });

    it('accepts an in-range action_index when actionCounts is known', async () => {
      const original = ['aa'];
      const parsed = [
        {
          pcztIndex: 0,
          id: new Uint8Array(0),
          signatures: [{ pool: POOL_ORCHARD, actionIndex: 2, signature: new Uint8Array(64) }],
        },
      ];
      const mockWasm = vi.fn(hex => `updated_${hex}`);

      await expect(
        mergeContributions(original, parsed, mockWasm, { actionCounts: [3] }),
      ).resolves.toBeDefined();
    });
  });
});
