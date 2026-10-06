/**
 * A zcash pocket's transparent balance, asked only when someone wants it.
 * Nothing here runs on a timer. Each address is asked on its own (see
 * each-address.ts); the last result is kept on this computer per pocket, so a
 * reopened zafu shows it with its age instead of asking the node again.
 */

import type { Utxo } from '../state/keyring/zidecar-client';
import { utxosEach, type ZcashClient } from '../state/keyring/zcash-backend';

export interface TransparentCheck {
  /** epoch ms the check finished */
  at: number;
  /** the chain tip it was asked at; 0 when not known */
  height: number;
  zat: bigint;
  /** how many addresses held coins */
  funded: number;
  /** this session's coins; never written to disk */
  utxos?: Utxo[];
}

export const checkKey = (storeId: string) => `zcashTransparentCheck:${storeId}`;

export const toStored = ({ at, height, zat, funded }: TransparentCheck) => ({
  at,
  height,
  zat: `${zat}`,
  funded,
});

/** a stored check, or null for anything else (never checked, a sealed or older shape) */
export const fromStored = (raw: unknown): TransparentCheck | null => {
  const r = raw as Partial<Record<keyof TransparentCheck, unknown>> | null | undefined;
  return r &&
    typeof r.at === 'number' &&
    typeof r.height === 'number' &&
    typeof r.funded === 'number' &&
    typeof r.zat === 'string' &&
    /^\d+$/.test(r.zat)
    ? { at: r.at, height: r.height, zat: BigInt(r.zat), funded: r.funded }
    : null;
};

export const runCheck = async (
  client: Pick<ZcashClient, 'getAddressUtxos'>,
  addresses: readonly string[],
  height: number,
  now = Date.now(),
): Promise<TransparentCheck> => {
  const utxos = await utxosEach(client, addresses);
  return {
    at: now,
    height,
    zat: utxos.reduce((sum, u) => sum + u.valueZat, 0n),
    funded: new Set(utxos.map(u => u.address)).size,
    utxos,
  };
};

/** the opt-in per-block refresh: on, and a tip newer than the one last checked at */
export const newTip = (on: boolean, tip: number, last: TransparentCheck | null | undefined) =>
  on && tip > (last?.height ?? 0);
