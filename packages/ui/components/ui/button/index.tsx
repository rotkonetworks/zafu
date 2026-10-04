import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../lib/utils';

/**
 * Button - primary / secondary / danger / quiet, sizes md (48px, the board's
 * action height) and sm (28px, dense inline actions). Square corners, 1px lines, no
 * shadows, one gold primary per screen (see packages/ui/styles/globals.css
 * and the design canvas). Icon support is a className on a child span
 * (`i-ph-*` / `i-lucide-*`), never a React icon component.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 font-inherit transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold disabled:pointer-events-none disabled:border disabled:border-border-soft disabled:bg-elev-2 disabled:text-fg-dim',
  {
    variants: {
      variant: {
        primary: 'border-0 bg-zigner-gold text-zigner-gold-foreground hover:bg-zigner-gold-light',
        secondary:
          'border border-border-soft bg-surface-elev-2 text-fg-high hover:bg-surface-border-soft',
        danger: 'border border-hanko bg-transparent text-hanko-light hover:bg-hanko/10',
        quiet: 'border-0 bg-transparent text-fg-muted hover:bg-surface-elev-1 hover:text-fg-high',
      },
      size: {
        md: 'h-12 px-4 text-sm',
        sm: 'h-7 px-2.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * Merges its props onto its immediate child.
   *
   * @see https://www.radix-ui.com/primitives/docs/utilities/slot#slot
   */
  asChild?: boolean;
  /** shows a spinner in place of the label and disables the button. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <span className='i-ph-spinner-gap size-4 animate-spin' aria-hidden='true' />
            <span className='sr-only'>loading</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
