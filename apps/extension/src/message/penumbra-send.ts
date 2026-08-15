/**
 * Message contract for a service-worker-driven Penumbra send.
 *
 * The page used to drive plan -> authorize+build -> broadcast itself over its
 * MessagePort (see hooks/penumbra-transaction.ts). That port dies the instant
 * the side panel reloads to show the approval, aborting the in-flight RPC - so
 * a send started from the side panel never actually broadcast.
 *
 * Instead the page fires one PenumbraSend message; the service worker runs the
 * whole sequence on an INTERNAL direct client that has no dependency on the
 * page's port, and writes progress to session storage keyed by opId. The page
 * (in popup-window mode, still alive) and the restored home screen (in panel
 * mode, after the panel reloaded) both read the result from there. The tx
 * completes regardless of what happens to the UI.
 */

import type { JsonValue } from '@bufbuild/protobuf';

export interface PenumbraSendRequest {
  type: 'PenumbraSend';
  /** unique id for this send, used as the session-storage key suffix */
  opId: string;
  /** TransactionPlannerRequest.toJson() - runtime messages are JSON, not
   *  structured-clone, so the protobuf's bigints must be serialized explicitly */
  planRequestJson: JsonValue;
}

export type PenumbraSendStatus =
  | 'planning'
  | 'building'
  | 'broadcasting'
  | 'success'
  | 'error';

/** Persisted state of one send, mirrored in chrome.storage.session. */
export interface PenumbraSendOp {
  opId: string;
  status: PenumbraSendStatus;
  /** hex tx id, present once broadcast succeeds */
  txId?: string;
  /** detection height, filled in later if awaited */
  blockHeight?: number;
  /** human-readable failure reason when status === 'error' */
  error?: string;
  /** memo text, carried so the home screen / SW can record it */
  memo?: string;
  /** recipient bech32m, for the message record */
  recipient?: string;
  /** ms timestamp of the last update - drives toast ordering + stale sweep */
  updatedAt: number;
}

export const PENUMBRA_SEND_OP_PREFIX = 'penumbraSendOp:';

export const sendOpKey = (opId: string): string => `${PENUMBRA_SEND_OP_PREFIX}${opId}`;

export const isPenumbraSendRequest = (m: unknown): m is PenumbraSendRequest =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === 'PenumbraSend' &&
  typeof (m as { opId?: unknown }).opId === 'string';

export const isTerminalStatus = (s: PenumbraSendStatus): boolean =>
  s === 'success' || s === 'error';
