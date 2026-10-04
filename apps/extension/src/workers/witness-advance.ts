/**
 * Advancing the per-note witnesses over one scanned batch, without letting one
 * bad witness cost the wallet all the others.
 *
 * The wasm update (witness_sync_update / _ironwood) folds a batch into the
 * pool's frontier and every witness at once, so a single witness it cannot
 * read used to throw the whole call - and the sync loop then blanked the
 * frontier, which stopped witness upkeep for the rest of the run and made the
 * next start refetch the frontier and drop every witness. Each send after that
 * paid a full replay from a checkpoint (the 60-120s "building witnesses").
 *
 * Here a failure narrows down instead: the frontier and the new notes advance
 * on their own, each existing witness is tried alone, and only the ones that
 * still fail are dropped (to be rebuilt in the background).
 */

export type WitnessUpdate = (
  frontier: string,
  blocksJson: string,
  existingJson: string,
  seedJson: string,
) => unknown;

export interface WitnessAdvance {
  end_frontier_hex: string;
  witnesses: { id: string; position?: number; witness_hex: string }[];
  /** existing witnesses that could not be advanced and must be rebuilt */
  dropped: string[];
}

type Parsed = Omit<WitnessAdvance, 'dropped'>;

export const advanceWitnesses = (
  update: WitnessUpdate,
  frontier: string,
  blocksJson: string,
  existing: { id: string; witness_hex: string }[],
  seed: { id: string; position: number }[],
): WitnessAdvance => {
  const run = (ex: typeof existing, sd: typeof seed): Parsed =>
    JSON.parse(
      update(frontier, blocksJson, JSON.stringify(ex), JSON.stringify(sd)) as string,
    ) as Parsed;
  try {
    return { ...run(existing, seed), dropped: [] };
  } catch (whole) {
    if (existing.length === 0) {
      // nothing to narrow down: the batch itself is unreadable
      throw whole;
    }
  }
  // the frontier and the new notes alone; if this fails too, the batch is the problem
  const base = run([], seed);
  const witnesses = [...base.witnesses];
  const dropped: string[] = [];
  for (const one of existing) {
    try {
      const r = run([one], []);
      if (r.end_frontier_hex !== base.end_frontier_hex) {
        dropped.push(one.id);
        continue;
      }
      witnesses.push(...r.witnesses.filter(w => w.id === one.id));
    } catch {
      dropped.push(one.id);
    }
  }
  return { end_frontier_hex: base.end_frontier_hex, witnesses, dropped };
};

/**
 * Does a stored frontier still stand for the synced height? The stored tree
 * size counts every action scanned up to that height, so when the frontier is
 * that size, nothing was added between its own height and the synced one: it
 * is the same tree, whatever height label it carries. A close and reopen used
 * to fail the old height-equality test after any run of empty blocks, refetch
 * the frontier and drop every witness - so the next send replayed from a
 * checkpoint.
 */
export const frontierHolds = (
  frontierSize: number,
  storedTreeSize: number,
  frontierHeight: number,
  syncedHeight: number,
): boolean => frontierSize === storedTreeSize && frontierHeight <= syncedHeight;
