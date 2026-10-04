import { Button, type ButtonProps } from '../button';
import { cn } from '../../../lib/utils';
import { useCopy } from '../../../hooks/use-copy';

/**
 * CopyButton - one hook (useCopy) plus a button. Icon flips to a check mark
 * and the label (if any) reads "copied" for 1.5s.
 *
 * Never use this for a seed phrase - seed display keeps its blurred reveal
 * only, no copy affordance anywhere.
 */
export function CopyButton({
  text,
  label,
  variant = 'quiet',
  size = 'sm',
  className,
  ...props
}: {
  text: string;
  /** shown next to the icon; omit for an icon-only button */
  label?: string;
} & Omit<ButtonProps, 'onClick' | 'children'>) {
  const { copied, copy } = useCopy();
  return (
    <Button
      type='button'
      variant={variant}
      size={size}
      className={cn('gap-1.5', className)}
      onClick={() => copy(text)}
      aria-label={label ? undefined : 'copy'}
      {...props}
    >
      <span className={cn(copied ? 'i-ph-check' : 'i-ph-copy', 'size-3.5')} aria-hidden='true' />
      {label && (copied ? 'copied' : label)}
    </Button>
  );
}
