import { cn } from '@repo/ui/lib/utils';

/** the "when did you start using this wallet" choices, three to a row */
export const StartPresets = ({
  labels,
  pick,
  onPick,
}: {
  labels: string[];
  pick: number | undefined;
  onPick: (i: number) => void;
}) => (
  <div className='grid grid-cols-3 gap-2.5'>
    {labels.map((label, i) => (
      <button
        key={label}
        type='button'
        aria-pressed={pick === i}
        onClick={() => onPick(i)}
        className={cn(
          'h-[52px] border text-body text-fg-high transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold',
          pick === i
            ? 'border-zigner-gold bg-zigner-gold/10'
            : 'border-border-soft bg-elev-1 hover:bg-elev-2',
        )}
      >
        {label}
      </button>
    ))}
  </div>
);
