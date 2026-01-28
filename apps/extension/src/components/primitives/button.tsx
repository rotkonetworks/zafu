/**
 * button primitives with instant feedback
 * perceived performance through immediate visual response
 */

import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cn } from '@repo/ui/lib/utils';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

/**
 * button with instant feedback
 * - immediate scale on press (active:scale-95)
 * - fast transitions (75ms)
 * - loading state with spinner
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center font-medium transition-all duration-75 active:scale-95 disabled:opacity-50 disabled:pointer-events-none';

    const variants = {
      primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
      secondary: 'bg-muted text-foreground hover:bg-muted/80',
      ghost: 'hover:bg-muted/50',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    };

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-10 px-4 text-sm',
      lg: 'h-12 px-6 text-base',
      icon: 'h-10 w-10',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {loading ? (
          <span className='animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full' />
        ) : (
          children
        )}
      </button>
    );
  }
);
Button.displayName = 'Button';

/**
 * icon button - square with icon
 * instant feedback on press
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'ghost', children, ...props }, ref) => (
    <Button ref={ref} variant={variant} size='icon' className={className} {...props}>
      {children}
    </Button>
  )
);
IconButton.displayName = 'IconButton';
