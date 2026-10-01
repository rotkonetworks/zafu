import { useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';

export interface SheetOption<T extends string | number> {
  value: T;
  label: string;
  desc?: string;
  warn?: string;
}

/**
 * A radio-card list for a Sheet's body - one option per row, a filled dot
 * marking the current value. Replaces the same hand-rolled radio-card block
 * that used to be pasted into auto-lock, transaction signing and the theme
 * picker.
 */
export function SheetOptions<T extends string | number>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: readonly SheetOption<T>[];
  onPick: (next: T) => void;
}) {
  return (
    <div className='flex flex-col gap-2'>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type='button'
            onClick={() => onPick(o.value)}
            className={cn(
              'flex items-start gap-3 border px-3.5 py-3 text-left transition-colors',
              on
                ? 'border-zigner-gold bg-zigner-gold/10'
                : 'border-surface-border-soft hover:bg-surface-elev-2',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                on ? 'border-zigner-gold' : 'border-surface-border',
              )}
            >
              {on && <span className='size-2 bg-zigner-gold' />}
            </span>
            <span className='flex flex-col'>
              <span className='text-data text-fg-high lowercase'>{o.label}</span>
              {o.desc && <span className='text-label text-fg-muted lowercase'>{o.desc}</span>}
              {o.warn && on && (
                <span className='mt-1 flex items-center gap-1 text-label text-warn lowercase'>
                  <span className='i-ph-warning size-3 shrink-0' />
                  {o.warn}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** a value Row that opens a Sheet of options */
export const OptionsRow = <T extends string | number>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; desc?: string }[];
  onPick: (v: T) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        type='value'
        label={label}
        value={options.find(o => o.value === value)?.label ?? String(value)}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title={label}>
        <SheetOptions
          value={value}
          options={options}
          onPick={v => {
            onPick(v);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
};
