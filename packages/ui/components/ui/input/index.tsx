import * as React from 'react';

import { cva, VariantProps } from 'class-variance-authority';
import { cn } from '../../../lib/utils';

/** board input: 48px, elev-1 ground, 1px line, square. */
const inputVariants = cva(
  'flex h-12 w-full border border-border-soft bg-elev-1 px-3 text-sm text-fg-high [appearance:textfield] file:border-0 file:bg-transparent file:text-sm placeholder:text-fg-muted focus-visible:border-zigner-gold focus-visible:outline-none disabled:cursor-not-allowed disabled:text-fg-dim [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
  {
    variants: {
      variant: {
        default: '',
        success: 'border-green',
        error: 'border-red',
        warn: 'border-warn',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>, VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ variant, className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(inputVariants({ variant, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
