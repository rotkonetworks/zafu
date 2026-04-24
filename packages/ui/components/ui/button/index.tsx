import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center px-4 font-inherit ring-offset-background transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-zigner-gold text-zigner-gold hover:bg-zigner-gold hover:text-zigner-gold-foreground',
        gradient: 'border border-zigner-gold text-zigner-gold hover:bg-zigner-gold hover:text-zigner-gold-foreground',
        secondary: 'border border-border-soft text-fg-muted hover:bg-elev-1 hover:text-fg-high',
        destructive: 'border border-destructive text-destructive hover:bg-destructive hover:text-white',
        destructiveSecondary: 'border border-destructive/50 text-destructive hover:bg-destructive/20',
        outline: 'border border-border-soft text-fg-muted hover:text-fg-high',
        ghost: 'hover:bg-elev-1 hover:text-fg-high',
        link: 'text-fg-muted underline-offset-4 hover:underline',
        onLight: 'border border-zigner-gold text-zigner-gold hover:bg-zigner-gold hover:text-zigner-gold-foreground',
      },
      size: {
        default: 'h-9 md:h-11',
        sm: 'h-[22px] text-xs font-normal',
        md: 'h-9',
        lg: 'h-11',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Merges its props onto its immediate child.
   *
   * @see https://www.radix-ui.com/primitives/docs/utilities/slot#slot
   */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
