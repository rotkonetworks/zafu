import { describe, expect, it } from 'vitest';
import {
  classifySyncFailure,
  isChainContinuityError,
  isEndpointFailoverCandidate,
  rewindDistanceForAttempt,
  syncFailureMessage,
  COMMITMENT_TREE_REWIND_DISTANCES,
  MAX_REWINDS_PER_RUN,
  SYNC_ERROR_CODES,
  type SyncFailureKind,
} from './sync-failure';

const KINDS: SyncFailureKind[] = [
  'network',
  'endpoint',
  'consensus',
  'chainRecovery',
  'storageBusy',
  'storageFatal',
  'unknown',
];

/** The three failures users actually hit, verbatim. */
const REAL_ERRORS = {
  ironwood: 'ironwood tree root mismatch at height 3437316',
  integrity:
    "server integrity check failed: nullifier root mismatch: server=49c3a1b2c3d4e5f6 proven=509f8e7d6c5b4a39. refusing to trust this endpoint's data - switch node or retry",
  broadcast:
    'broadcast failed (-1): zebrad RPC error: RPC error -1: transaction dropped because it is already queued for download',
};

describe('classifySyncFailure — structured codes', () => {
  it('honours a code emitted by the worker over anything in the text', () => {
    // The text looks like a chain rewind; the worker says it is consensus.
    // The worker wins — it knows where it threw from.
    expect(classifySyncFailure('tree root mismatch at height 100', 'consensus').kind).toBe(
      'consensus',
    );
    expect(classifySyncFailure('some opaque wasm panic', 'storage-busy').kind).toBe('storageBusy');
  });

  it('reads a code off a tagged Error object', () => {
    const tagged = Object.assign(new Error('anything at all'), { syncCode: 'endpoint' });
    expect(classifySyncFailure(tagged).kind).toBe('endpoint');
  });

  it('ignores a code it does not recognise and falls back to sniffing', () => {
    expect(classifySyncFailure('connection refused', 'not-a-code').kind).toBe('network');
  });

  it('maps every declared code to a kind', () => {
    for (const code of SYNC_ERROR_CODES) {
      const failure = classifySyncFailure('x', code);
      expect(KINDS).toContain(failure.kind);
    }
  });
});

describe('classifySyncFailure — sniffed', () => {
  it.each([
    ['network: connection reset by peer', 'network'],
    ['TypeError: Failed to fetch', 'network'],
    ['request timed out after 30s', 'network'],
    ['http 503 from upstream', 'network'],
    ['invalid url: zcash.example', 'endpoint'],
    ['415 unsupported media type', 'endpoint'],
    ['wrong network: endpoint is for testnet', 'endpoint'],
    ['server integrity check failed: proof invalid', 'consensus'],
    ['commitment proof for unrequested cmx abcd', 'consensus'],
    ['commitment proof count mismatch: asked 8, got 7', 'consensus'],
    ['tree root mismatch after backfill at height 3437316', 'chainRecovery'],
    ['PrevHashMismatch at 2500000', 'chainRecovery'],
    ['BlockHeightDiscontinuity', 'chainRecovery'],
    ['local frontier diverged from network', 'chainRecovery'],
    ['database is locked', 'storageBusy'],
    ['version change transaction was blocked', 'storageBusy'],
    ['QuotaExceededError: idb write failed', 'storageFatal'],
    ['UnknownError: Internal error opening backing store for indexedDB', 'storageFatal'],
    ['something nobody has ever seen', 'unknown'],
  ] as [string, SyncFailureKind][])('classifies %s as %s', (raw, kind) => {
    expect(classifySyncFailure(raw).kind).toBe(kind);
  });

  it('accepts Errors, strings, and junk without throwing', () => {
    expect(classifySyncFailure(new Error('connection refused')).kind).toBe('network');
    expect(classifySyncFailure({ message: 'database is locked' }).kind).toBe('storageBusy');
    expect(classifySyncFailure(null).kind).toBe('unknown');
    expect(classifySyncFailure(undefined).raw).toBe('undefined');
  });

  it('does not read a block height as an http status', () => {
    // A bare "503"/"415" substring lives inside plenty of block heights;
    // matching it would turn a chain problem into "the network is down".
    expect(classifySyncFailure('tree root mismatch at height 3503415').kind).toBe('chainRecovery');
    expect(classifySyncFailure('scan stalled at 2415033').kind).toBe('unknown');
  });
});

describe('the three failures users actually hit', () => {
  it('a tree root mismatch is chain recovery, and self-heals', () => {
    const failure = classifySyncFailure(REAL_ERRORS.ironwood);
    expect(failure.kind).toBe('chainRecovery');
    expect(failure.autoRetries).toBe(true);
    expect(failure.raw).toBe(REAL_ERRORS.ironwood);
  });

  it('a server integrity failure is consensus, not a chain rewind', () => {
    const failure = classifySyncFailure(REAL_ERRORS.integrity);
    expect(failure.kind).toBe('consensus');
    expect(failure.autoRetries).toBe(false);
    // it is a node-attributable failure, so pointing at the node is honest
    expect(failure.action?.kind).toBe('settings');
  });

  it('an already-queued broadcast is not reported as a failed payment', () => {
    const failure = classifySyncFailure(REAL_ERRORS.broadcast);
    expect(failure.autoRetries).toBe(true);
    expect(failure.kind).not.toBe('consensus');
    expect(failure.kind).not.toBe('storageFatal');
    expect(failure.message).toContain('already has this transaction');
    // never phrased as the user's payment having failed
    expect(failure.message).not.toMatch(/fail|error|reject/i);
  });
});

describe('message copy discipline', () => {
  const messages = [
    ...KINDS.map(syncFailureMessage),
    ...Object.values(REAL_ERRORS).map(e => classifySyncFailure(e).message),
  ];

  it('never leaks internal vocabulary', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/mismatch|nullifier|root|commitment|frontier|wasm|indexeddb/i);
    }
  });

  it('never contains a height, a hash, or any hex blob', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\d{4,}/); // heights
      expect(message).not.toMatch(/\b[0-9a-f]{8,}\b/i); // hashes / hex
      expect(message).not.toMatch(/0x/);
    }
  });

  it('is lowercase, matching the sync surface it renders into', () => {
    for (const message of messages) {
      expect(message[0]).toBe(message[0]?.toLowerCase());
    }
  });

  it('keeps the raw text available for diagnostics but out of the message', () => {
    const failure = classifySyncFailure(REAL_ERRORS.ironwood);
    expect(failure.raw).toContain('3437316');
    expect(failure.message).not.toContain('3437316');
  });

  it('says either that we retry, or what the person should do', () => {
    for (const kind of KINDS) {
      expect(syncFailureMessage(kind).length).toBeGreaterThan(20);
    }
    // self-healing kinds say so
    expect(syncFailureMessage('network')).toMatch(/automatically/);
    expect(syncFailureMessage('storageBusy')).toMatch(/automatically/);
    expect(syncFailureMessage('chainRecovery')).toMatch(/keep trying/);
    // the rest name an action for the person
    expect(syncFailureMessage('endpoint')).toMatch(/check your endpoint settings/);
    expect(syncFailureMessage('storageFatal')).toMatch(/reload zafu/);
    expect(syncFailureMessage('unknown')).toMatch(/try again/);
  });

  it('defaults an unclassified failure to visible rather than silently retried', () => {
    const failure = classifySyncFailure('something nobody has ever seen');
    expect(failure.kind).toBe('unknown');
    expect(failure.autoRetries).toBe(false);
    expect(failure.action).toBeDefined();
  });
});

describe('endpoint failover is its own axis', () => {
  it('only transport-shaped failures may move the wallet to another node', () => {
    expect(isEndpointFailoverCandidate(classifySyncFailure('connection refused'))).toBe(true);
    expect(isEndpointFailoverCandidate(classifySyncFailure('invalid url'))).toBe(true);
  });

  it('never rotates the endpoint for a local or chain problem', () => {
    for (const raw of [
      REAL_ERRORS.ironwood,
      REAL_ERRORS.integrity,
      'database is locked',
      'QuotaExceededError',
      'something nobody has ever seen',
    ]) {
      expect(isEndpointFailoverCandidate(classifySyncFailure(raw))).toBe(false);
    }
  });

  it('does not offer a "switch node" action for local failures', () => {
    for (const raw of ['database is locked', 'QuotaExceededError', 'who knows']) {
      expect(classifySyncFailure(raw).action?.kind).not.toBe('settings');
    }
  });
});

describe('chain continuity recovery', () => {
  it('recognises the errors the sync loop can rewind out of', () => {
    expect(isChainContinuityError(REAL_ERRORS.ironwood)).toBe(true);
    expect(isChainContinuityError('tree root mismatch after backfill at height 10')).toBe(true);
    expect(
      isChainContinuityError(Object.assign(new Error('x'), { syncCode: 'chain-recovery' })),
    ).toBe(true);
  });

  it('refuses to swallow a consensus failure as a rewindable one', () => {
    // This is the money-path guard: an integrity failure must stay visible,
    // never be "recovered from" by quietly rewinding and rescanning.
    expect(isChainContinuityError(REAL_ERRORS.integrity)).toBe(false);
    expect(isChainContinuityError('server integrity check failed: proof root mismatch')).toBe(
      false,
    );
    expect(isChainContinuityError(Object.assign(new Error('x'), { syncCode: 'consensus' }))).toBe(
      false,
    );
  });

  it('leaves network and storage failures to their own retry paths', () => {
    expect(isChainContinuityError('connection refused')).toBe(false);
    expect(isChainContinuityError('database is locked')).toBe(false);
    expect(isChainContinuityError('who knows')).toBe(false);
  });

  it('escalates the rewind distance per attempt and then holds', () => {
    expect(rewindDistanceForAttempt(0)).toBe(10);
    expect(rewindDistanceForAttempt(1)).toBe(100);
    expect(rewindDistanceForAttempt(2)).toBe(1000);
    expect(rewindDistanceForAttempt(99)).toBe(1000);
    expect(rewindDistanceForAttempt(-1)).toBe(10);
  });

  it('keeps the rewind budget bounded and non-zero', () => {
    // 0 would defeat the whole point (every reorg visible again); a large
    // budget lets a flapping chain rewind the wallet backwards forever.
    expect(MAX_REWINDS_PER_RUN).toBeGreaterThanOrEqual(1);
    expect(MAX_REWINDS_PER_RUN).toBeLessThanOrEqual(10);
    expect(COMMITMENT_TREE_REWIND_DISTANCES.length).toBe(MAX_REWINDS_PER_RUN);
  });
});
