/**
 * Wallet-side OTA session state machine (spec §9).
 *
 *   idle → streaming → awaiting_tap → awaiting_result → recorded
 *
 * with explicit per-state deadlines (result timeout ~120s, stream
 * staleness) and an abort path that leaves device state untouched. A device
 * that discards a stream simply never sends a result — the wallet then shows
 * "no update applied".
 *
 * Correlation is via a random 8-byte req_id (NOT crypto, spec §5.4). req_id
 * mismatches on a result are tolerated for replay purposes, but the wallet
 * still shows "no update applied" when no result arrives.
 */

import { RESULT_TIMEOUT_MS, STREAM_STALENESS_MS } from './keys';
import { SessionPhase } from './types';

export interface OtaSession {
  /** current phase */
  phase: SessionPhase;
  /** 8-byte correlation id (hex) for this session */
  reqId?: string;
  /** target (new) firmware version being pushed */
  targetVersion?: string;
  /** epoch ms the session started */
  startedAt: number;
  /** epoch ms of the last stream "freshness" heartbeat */
  lastStreamAt: number;
  /** human-readable error (phase === Error) */
  error?: string;
  /** whether a result was actually recorded */
  recorded: boolean;
}

/** Generate an 8-byte random session correlation id (returned as hex). */
export function generateReqId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function now(): number {
  return Date.now();
}

export function createOtaSession(): OtaSession {
  return {
    phase: SessionPhase.Idle,
    startedAt: 0,
    lastStreamAt: 0,
    recorded: false,
  };
}

/** Begin streaming: registers the correlation id + target version. */
export function beginStreaming(session: OtaSession, reqId: string, targetVersion: string): OtaSession {
  const t = now();
  return {
    ...session,
    phase: SessionPhase.Streaming,
    reqId,
    targetVersion,
    startedAt: t,
    lastStreamAt: t,
    recorded: false,
    error: undefined,
  };
}

/** Refresh the stream staleness heartbeat. */
export function touchStream(session: OtaSession): OtaSession {
  return { ...session, lastStreamAt: now() };
}

/** The verified stream is ready; the user must tap the device. */
export function beginAwaitingTap(session: OtaSession): OtaSession {
  return { ...session, phase: SessionPhase.AwaitingTap, lastStreamAt: now() };
}

/** The user tapped; we now wait for the device result (~120s). */
export function beginAwaitingResult(session: OtaSession): OtaSession {
  return { ...session, phase: SessionPhase.AwaitingResult, lastStreamAt: now() };
}

/** Mark the session recorded after a verified result. */
export function markRecorded(session: OtaSession): OtaSession {
  return { ...session, phase: SessionPhase.Recorded, recorded: true };
}

/** Abort — leaves device state untouched and returns to idle. */
export function abort(session: OtaSession, error?: string): OtaSession {
  return { ...session, phase: SessionPhase.Error, error, recorded: session.recorded };
}

/** True when we've been waiting for a result longer than the timeout. */
export function isResultExpired(session: OtaSession, at: number = now()): boolean {
  if (session.phase !== SessionPhase.AwaitingResult && session.phase !== SessionPhase.AwaitingTap) {
    return false;
  }
  return at - session.lastStreamAt > RESULT_TIMEOUT_MS;
}

/** True when the stream hasn't made progress within the staleness window. */
export function isStreamStale(session: OtaSession, at: number = now()): boolean {
  if (session.phase !== SessionPhase.Streaming) {
    return false;
  }
  return at - session.lastStreamAt > STREAM_STALENESS_MS;
}

/**
 * Tolerate a result whose req_id does not match this session (replay of a
 * signed image is not an attack — spec §5.4). Only recorded once verified.
 */
export function acceptsResultForReplay(session: OtaSession): boolean {
  return session.phase === SessionPhase.AwaitingResult;
}
