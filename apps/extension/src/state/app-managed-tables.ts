/**
 * App-managed (poker-table) multisig POLICY — pure, composable predicates.
 *
 * Structured like a server selector/filter layer: tiny predicates, composed into `relevance`,
 * `applyTableFilter`, and `deleteFriction`. The manager UI is a thin renderer over these — all the
 * money-safety decisions (what to show, how hard delete should be) live here where they're testable
 * in isolation, not scattered through JSX.
 *
 * Money-safety invariant: everything here FAILS CLOSED. A table we cannot prove is empty (an
 * unsynced hidden table reads balance 0, but that 0 may hide a mempool / unscanned deposit) is
 * treated as *possibly funded* — it stays visible and it gets the guarded delete path. We never
 * downgrade friction, or hide a table as "settled", on an unproven zero.
 */

import type { ZcashWalletJson } from './wallets';

/** A table row's money view. `balanceZat` is the last-known scanned balance — a LOWER BOUND only
 *  when `synced` is false (the scanner may not have run for this vault). `createdAt` comes from the
 *  parent vault record (EncryptedVault.createdAt), not the mirror wallet. */
export interface TableView {
  wallet: ZcashWalletJson;
  balanceZat: bigint;
  synced: boolean;
  createdAt?: number;
}

/** default "recent" window: a table created within the last 7 days is still interesting even if it
 *  currently reads empty (a just-finished game, a deposit about to land). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── predicates ──────────────────────────────────────────────────────────────

/** definitely holds money (as far as the last scan saw). */
export const hasFunds = (t: TableView): boolean => t.balanceZat > 0n;

/** we could NOT prove this table is empty — no trustworthy sync to the chain tip for this vault.
 *  Treated as possibly-funded everywhere (fail-closed). */
export const isUnverified = (t: TableView): boolean => !t.synced;

/** created within `windowMs`. */
export const isRecent = (t: TableView, now: number, windowMs = RECENT_WINDOW_MS): boolean =>
  t.createdAt !== undefined && now - t.createdAt < windowMs;

/** PROVABLY empty: synced to tip AND zero balance. The ONLY state that earns low-friction delete. */
export const isConfidentlyEmpty = (t: TableView): boolean => t.synced && t.balanceZat === 0n;

// ── relevance (what the manager shows by default) ───────────────────────────

/** A table is "relevant" — worth showing by default — if it holds money, can't be proven empty, or
 *  is recent. Old, synced-empty tables are noise and are hidden unless the user asks for "show all".
 *  Note isUnverified ⇒ shown: an unsynced table is never silently dropped as if it were settled. */
export const isRelevant = (t: TableView, now: number): boolean =>
  hasFunds(t) || isUnverified(t) || isRecent(t, now);

// ── filter (search + toggles), composed ─────────────────────────────────────

export interface TableFilter {
  /** case-insensitive substring match on the table label. */
  query?: string;
  /** show ONLY tables that currently read a positive balance. */
  onlyFunded?: boolean;
  /** include old, synced-empty tables that `isRelevant` would otherwise hide. */
  showAll?: boolean;
}

/** Apply the filter. Order: label query → funded toggle → relevance (unless showAll). Pure. */
export const applyTableFilter = (tables: TableView[], f: TableFilter, now: number): TableView[] =>
  tables.filter(t => {
    if (f.query && !t.wallet.label.toLowerCase().includes(f.query.toLowerCase())) {
      return false;
    }
    if (f.onlyFunded && !hasFunds(t)) {
      return false;
    }
    if (!f.showAll && !isRelevant(t, now)) {
      return false;
    }
    return true;
  });

// ── delete policy ───────────────────────────────────────────────────────────

/**
 * How hard deletion should be for a table.
 *  - 'easy'    : provably empty (synced && balance 0) — a light confirm is fine, nothing to lose.
 *  - 'guarded' : funded OR unverifiable — require the heavy "you will lose access to these funds,
 *                and co-signers who rely on your share may lose access too" warning + typed intent
 *                + an offer to export a backup first.
 * Fail-closed: only `isConfidentlyEmpty` yields 'easy'; every uncertain case is 'guarded'.
 */
export type DeleteFriction = 'easy' | 'guarded';

export const deleteFriction = (t: TableView): DeleteFriction =>
  isConfidentlyEmpty(t) ? 'easy' : 'guarded';
