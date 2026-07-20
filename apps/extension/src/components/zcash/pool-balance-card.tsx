/**
 * Dual-pool (Orchard + Ironwood) balance card for the Zcash home surface.
 *
 * NU6.3 turnstile framing: Ironwood is the active pool (primary hero
 * balance); Orchard is legacy (migrate-only) and is surfaced as a subtle
 * secondary row with a "migrate to Ironwood" affordance - ONLY when the
 * wallet still holds Orchard funds. When Orchard drains to 0 the legacy
 * row disappears and only the Ironwood balance remains.
 *
 * Pre-activation reads the same: if Ironwood is 0 and Orchard > 0 (typical
 * pre/at-activation), the card still makes sense - it shows the Orchard
 * legacy row plus the migrate CTA. Orchard funds are never framed as lost:
 * they are safe, just migrate-only after activation.
 *
 * Presentational + a single selector read. The parent mounts this on home
 * and wires `onMigrate` to the existing IRONWOOD_MIGRATION flow. This
 * component does not build or broadcast anything.
 */

import { Sensitive } from '../sensitive';
import type { PoolBalances } from '../../state/keyring/network-worker';

export type { PoolBalances };

/**
 * Format zatoshi -> ZEC string. Mirrors the home balance formatter
 * (`fmtZec` in routes/popup/home/index.tsx): trim trailing zeros, but keep
 * at least two decimal places so amounts read consistently across the wallet.
 */
const fmtZec = (zat: bigint): string => {
  const val = Number(zat) / 1e8;
  if (val === 0) {
    return '0';
  }
  const s = val.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) {
    return `${s}.00`;
  }
  const decimals = s.length - dot - 1;
  return decimals < 2 ? s + '0'.repeat(2 - decimals) : s;
};

export interface PoolBalanceCardProps {
  /**
   * Per-pool spendable balances (zatoshi). The parent reads these from the
   * `usePoolBalances` hook and passes them in - this component stays
   * presentational and does not touch the worker.
   */
  balances: PoolBalances;
  /**
   * Opens the existing IRONWOOD_MIGRATION flow. Wired by the parent (home).
   * Only invoked from the legacy-row migrate affordance.
   */
  onMigrate: () => void;
  /**
   * When false, the migrate action explains it is unavailable until NU6.3
   * activates (guard fail-closed / pre-activation). Defaults to true so a
   * live turnstile is the common case.
   */
  migrationAvailable?: boolean;
  /**
   * Sub-line under the hero balance, e.g. `synced · block 2,845,120` or
   * `syncing · 42.1%`. Optional so the card can render standalone.
   */
  statusLine?: string;
}

/**
 * Dual-pool balance card. Ironwood is primary; Orchard is a legacy row shown
 * only when its balance is positive.
 */
export const PoolBalanceCard = ({
  balances,
  onMigrate,
  migrationAvailable = true,
  statusLine,
}: PoolBalanceCardProps) => {
  const { orchard, ironwood } = balances;

  const hasLegacyOrchard = orchard > 0n;

  return (
    <div className='flex flex-col gap-2'>
      {/* Ironwood - primary active balance. Matches the existing zcash
          balance card: network-accent hero figure inside an elev-1 box. */}
      <div className='rounded-md border border-network-accent/20 bg-elev-1 p-4'>
        <div className='flex items-center gap-1.5'>
          <span className='kicker'>Ironwood balance</span>
          <span
            className='i-lucide-shield-check h-3 w-3 text-network-accent/70'
            title='Ironwood - active shielded pool'
          />
        </div>
        <div className='mt-1 text-display leading-none text-network-accent tabular'>
          <Sensitive>{`${fmtZec(ironwood)} ZEC`}</Sensitive>
        </div>
        {statusLine && <div className='mt-1 text-label text-fg-dim tabular'>{statusLine}</div>}
      </div>

      {/* Orchard - legacy row, only when funds remain. Subtle (elev-1, muted
          type) so it reads as secondary to the Ironwood hero. Never framed
          as lost: "legacy" + migrate affordance. */}
      {hasLegacyOrchard && (
        <div className='rounded-md border border-border-soft bg-elev-1 p-3'>
          <div className='flex items-center justify-between gap-2'>
            <div className='flex min-w-0 items-center gap-2'>
              <span className='i-lucide-clock h-3.5 w-3.5 shrink-0 text-fg-muted' />
              <span className='text-xs text-fg-muted'>Orchard</span>
              <span className='rounded-md bg-elev-2 px-1.5 py-0.5 text-label text-fg-dim leading-none'>
                legacy
              </span>
              <Sensitive className='truncate text-xs tabular-nums text-fg-high'>
                {`${fmtZec(orchard)} ZEC`}
              </Sensitive>
            </div>
            {migrationAvailable ? (
              <button
                type='button'
                onClick={onMigrate}
                className='shrink-0 text-xs font-medium text-zigner-gold transition-colors hover:text-primary/90'
              >
                migrate to Ironwood
              </button>
            ) : (
              <span
                className='shrink-0 text-label text-fg-dim'
                title='migration opens when NU6.3 activates'
              >
                available when NU6.3 activates
              </span>
            )}
          </div>
          {/* one tight line - Orchard funds are safe, just migrate-only. */}
          <p className='mt-1.5 text-label text-fg-muted leading-snug'>
            NU6.3 makes Orchard migrate-only. move these funds through the one-way turnstile to keep
            spending them - your Orchard balance stays safe until you do.
          </p>
        </div>
      )}
    </div>
  );
};

export default PoolBalanceCard;
