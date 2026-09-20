/**
 * ZcashBirthdayField - the shared "when was this wallet first used" input.
 *
 * The wallet birthday is stored as a block HEIGHT (sync consumes a height),
 * but a person only knows a DATE, so the date is the primary control and the
 * height lives under an `advanced` toggle. The date control is the plain
 * `<input type='date'>` calendar - deliberately the same one settings uses,
 * not a bespoke calendar - so both sites read and round identically via the
 * helpers in utils/zcash-blocks.ts.
 *
 * Fully controlled: the parent owns the height (`value`, null when unset) and
 * decides what to persist. A local draft string backs the block input so the
 * user can type intermediate digits without the parent clobbering the caret.
 */

import { useEffect, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import {
  blockToDate,
  dateToBlock,
  describeZcashHeight,
  formatDateInput,
} from '../../utils/zcash-blocks';
import { ZCASH_ORCHARD_ACTIVATION } from '../../config/networks';

interface ZcashBirthdayFieldProps {
  /** Current birthday height, or null when unset. */
  readonly value: number | null;
  /** New height from a date pick or block entry, or null to clear. */
  readonly onChange: (height: number | null) => void;
  /** Show the "clear" affordance in the advanced row. */
  readonly allowClear?: boolean;
  readonly className?: string;
}

export const ZcashBirthdayField = ({
  value,
  onChange,
  allowClear = true,
  className,
}: ZcashBirthdayFieldProps) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [blockDraft, setBlockDraft] = useState(value == null ? '' : String(value));

  // Keep the block draft in sync when the parent height changes from the
  // outside (a date pick, a clear). Guard against feedback loops by only
  // syncing when the numeric values actually differ.
  useEffect(() => {
    const draftNum = parseInt(blockDraft, 10);
    const current = value == null ? NaN : value;
    if (draftNum !== current && !(isNaN(draftNum) && value == null)) {
      setBlockDraft(value == null ? '' : String(value));
    }
  }, [value]);

  const valid = value != null && value >= ZCASH_ORCHARD_ACTIVATION;
  const draftNum = parseInt(blockDraft, 10);
  const hint = blockDraft.trim() ? describeZcashHeight(draftNum) : null;

  const onPickDate = (dateStr: string) => {
    if (!dateStr) {
      onChange(null);
      return;
    }
    onChange(dateToBlock(new Date(dateStr + 'T00:00:00Z')));
  };

  const commitBlock = () => {
    if (blockDraft.trim() === '') {
      onChange(null);
      return;
    }
    if (!isNaN(draftNum) && draftNum > 0) {
      onChange(Math.max(ZCASH_ORCHARD_ACTIVATION, draftNum));
    }
  };

  return (
    <div className={cn('rounded-md border border-border-soft/70 px-2.5 py-2', className)}>
      <div className='flex flex-wrap items-center gap-2'>
        <span
          className='i-ph-calendar-blank size-3.5 text-fg-muted shrink-0'
          title='when this wallet was first used - scanning starts here'
        />
        <span className='text-label text-fg-muted whitespace-nowrap lowercase'>first used</span>
        <input
          type='date'
          min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
          max={formatDateInput(new Date())}
          value={valid ? formatDateInput(blockToDate(value)) : ''}
          onChange={e => onPickDate(e.target.value)}
          className='bg-input border border-border-soft px-2 py-1.5 text-label font-mono rounded focus:outline-none focus:border-primary/50'
        />
        <button
          type='button'
          onClick={() => setShowAdvanced(v => !v)}
          title='set the start block directly'
          className='ml-auto text-label text-fg-dim hover:text-fg-muted transition-colors'
        >
          <span
            className={cn(
              'i-ph-sliders-horizontal size-3.5 transition-transform',
              showAdvanced && 'text-fg-muted',
            )}
          />
        </button>
      </div>

      {showAdvanced && (
        <div className='mt-2 flex flex-wrap items-center gap-2 border-t border-border-soft/70 pt-2'>
          <span className='text-label text-fg-muted whitespace-nowrap lowercase'>block</span>
          <input
            type='number'
            min={ZCASH_ORCHARD_ACTIVATION}
            step='1'
            value={blockDraft}
            onChange={e => setBlockDraft(e.target.value)}
            onBlur={commitBlock}
            onKeyDown={e => e.key === 'Enter' && commitBlock()}
            placeholder='auto'
            className='w-28 bg-input border border-border-soft px-2 py-1.5 text-label font-mono rounded focus:outline-none focus:border-primary/50'
          />
          {hint && (
            <span className={cn('text-label', hint.ok ? 'text-fg-dim' : 'text-hanko')}>
              {hint.text}
            </span>
          )}
          {allowClear && value != null && (
            <button
              type='button'
              onClick={() => {
                setBlockDraft('');
                onChange(null);
              }}
              className='ml-auto text-label text-fg-dim hover:text-hanko transition-colors lowercase'
            >
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
};
