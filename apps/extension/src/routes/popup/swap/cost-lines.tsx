/** what a swap costs, as the route row, the review and the receipt show it */

import { Sensitive } from '../../../components/sensitive';
import { ZAFU_BETA_FREE, zafuListBps } from '../../../config/swap-fee';
import { figure, pct, type Cost, type CostPart } from '../../../state/swap/provider';

/**
 * zafu's rate: the normal rate struck through, the beta price, and how much
 * that takes off, all from the two configured rates; in the free beta, the
 * normal rate struck through and "free in beta". Otherwise a plain 0%.
 */
const ZafuRate = ({ bps }: { bps: number }) => {
  const list = zafuListBps();
  return bps > 0 && bps < list ? (
    <>
      <s>{pct(list)}</s> <span className='text-success'>{pct(bps)}</span>{' '}
      <span className='text-fg-muted'>{Math.round(100 - (bps * 100) / list)}% off in beta</span>
    </>
  ) : bps === 0 && list > 0 && ZAFU_BETA_FREE ? (
    <>
      <s>{pct(list)}</s> <span className='text-success'>free in beta</span>
    </>
  ) : (
    <>{pct(bps)}</>
  );
};

const Rate = ({ part }: { part: CostPart }) =>
  part.zafu ? <ZafuRate bps={part.bps} /> : <>{pct(part.bps)}</>;

/** route row: the total, then every part on one line */
export const CostMeta = ({ cost, unit, decimals }: Units & { cost: Cost }) => (
  <>
    <span>
      total ≈ {pct(cost.bps)} · <Sensitive>{`${figure(cost.out, decimals)} ${unit}`}</Sensitive>
    </span>
    {cost.parts.map(p => (
      <span key={p.label}>
        {p.label} <Rate part={p} />
      </span>
    ))}
  </>
);

interface Units {
  unit: string;
  decimals: number;
}

/** review and receipt: the total, each part listed under it */
export const CostList = ({ cost, unit, decimals }: Units & { cost: Cost }) => {
  const worth = (p: { out: bigint; inText?: string }) =>
    p.inText ?? `${figure(p.out, decimals)} ${unit}`;
  return (
    <>
      {[{ label: 'total ≈', bps: cost.bps, out: cost.out } as CostPart, ...cost.parts].map(
        (p, i) => (
          <div key={p.label} className='flex justify-between gap-3'>
            <span className={i ? 'shrink-0 pl-3 text-fg-muted' : 'shrink-0 text-fg-muted'}>
              {p.label}
            </span>
            <span className='text-right font-mono'>
              <Rate part={p} /> · <Sensitive>{worth(p)}</Sensitive>
            </span>
          </div>
        ),
      )}
    </>
  );
};
