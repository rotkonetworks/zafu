/**
 * ToggleSwitch - the one on/off affordance for the whole popup.
 *
 * A rounded track that is bg-network-accent with the knob on the RIGHT when
 * on, and bg-elev-2/border-soft with the knob on the LEFT when off, so the
 * state is instantly readable without parsing text. Tokens only (DESIGN.md) -
 * no raw green, the accent rebinds per network.
 */

import { cn } from '@repo/ui/lib/utils';

export const ToggleSwitch = ({
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
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
      'focus:outline-none focus-visible:ring-1 focus-visible:ring-network-accent',
      checked ? 'border-network-accent bg-network-accent' : 'border-border-soft bg-elev-2',
      disabled && 'cursor-not-allowed opacity-40',
      className,
    )}
  >
    <span
      className={cn(
        'block size-3.5 rounded-full shadow-sm transition-transform',
        checked
          ? 'translate-x-[19px] bg-network-accent-foreground'
          : 'translate-x-[2px] bg-fg-muted',
      )}
    />
  </button>
);
