import { cn } from '../../../lib/utils';

/**
 * Toggle - the one on/off affordance for the whole popup. role="switch", a
 * square 36x20 track: accent line, tint and knob on the right when on; line2
 * on canvas with a dim knob on the left when off.
 */
export const Toggle = ({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** accessible name for the switch */
  label?: string;
  disabled?: boolean;
  className?: string;
}) => (
  <button
    type='button'
    role='switch'
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 items-center border transition-colors',
      'focus:outline-none focus-visible:ring-1 focus-visible:ring-network-accent',
      checked ? 'border-network-accent bg-network-accent/20' : 'border-border-hard bg-canvas',
      disabled && 'cursor-not-allowed opacity-40',
      className,
    )}
  >
    <span
      className={cn(
        'block size-3.5 transition-transform',
        checked ? 'translate-x-[19px] bg-network-accent' : 'translate-x-[2px] bg-fg-dim',
      )}
    />
  </button>
);
