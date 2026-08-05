import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

/**
 * transaction fee — ZIP-317 multiple.
 *
 * Zcash has no fee market: ZIP-317 is a flat consensus rule (5,000 zat per
 * logical action) and blocks are not full, so paying more buys no speed. It
 * does, however, make your transactions *distinguishable* — a wallet paying a
 * non-standard fee stands out in the anonymity set and links its own
 * transactions to each other. That is why the standard fee is the default and
 * anything else carries a warning.
 *
 * Below-standard is not offered at all: zebra rejects those outright
 * ("Unpaid actions is higher than the limit"), so it could only break sends.
 */

const OPTIONS = [
  { mult: 1, name: 'standard', blurb: 'ZIP-317 network rule — same as every other wallet' },
  { mult: 1.5, name: '1.5×', blurb: 'above standard' },
  { mult: 2, name: '2×', blurb: 'above standard' },
  { mult: 3, name: '3×', blurb: 'well above standard' },
] as const;

export const SettingsFees = () => {
  const [mult, setMult] = useState(1);

  useEffect(() => {
    void localExtStorage.get('zafuFeeMultiplier').then(v => {
      setMult(typeof v === 'number' && Number.isFinite(v) ? Math.max(1, v) : 1);
    });
  }, []);

  const pick = (m: number) => {
    setMult(m);
    void localExtStorage.set('zafuFeeMultiplier', m);
  };

  return (
    <SettingsScreen title='fees' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4 px-4'>
        <p className='text-label text-fg-muted leading-snug'>
          zcash has no fee auction — ZIP-317 sets one flat rate and blocks are not full, so a higher
          fee does not confirm faster.
        </p>

        <div className='flex flex-col gap-2'>
          {OPTIONS.map(o => (
            <button
              key={o.mult}
              onClick={() => pick(o.mult)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                mult === o.mult
                  ? 'border-zigner-gold/60 bg-elev-1'
                  : 'border-border-soft hover:bg-elev-1',
              )}
            >
              <span className='flex flex-1 flex-col'>
                <span className='text-data text-fg lowercase'>
                  {o.name}
                  {o.mult === 1 && <span className='ml-2 text-label text-fg-dim'>recommended</span>}
                </span>
                <span className='text-label text-fg-dim lowercase'>{o.blurb}</span>
              </span>
              {mult === o.mult && <span className='i-lucide-check size-4 text-zigner-gold' />}
            </button>
          ))}
        </div>

        {mult !== 1 && (
          <div className='flex items-start gap-2 rounded-md border border-hanko/40 bg-elev-1 p-3'>
            <span className='i-lucide-alert-triangle mt-0.5 size-3.5 shrink-0 text-hanko' />
            <p className='text-label text-fg-muted leading-snug'>
              <span className='text-hanko'>you are paying a non-standard fee.</span> it will not
              confirm faster, and it makes your transactions stand out — anyone watching the chain
              can pick them out of the crowd and link them to each other. the standard fee is what
              every other wallet pays, which is exactly what makes it private.
            </p>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};
