import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../../../lib/utils';

/**
 * Sheet - a bottom sheet over a scrim. Built on @radix-ui/react-dialog, so
 * focus trap, Esc-to-close, outside-click-to-close, role="dialog" and the
 * aria-labelledby wiring to the title are all free from radix; this only
 * supplies the shape (fixed to the bottom, square corners, 1px top border)
 * and the tokens. The screen under it never moves (see the canvas
 * "structure" rule) - options, pickers and confirmations rise over it here.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the sheet's accessible name; also rendered as its heading. */
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-scrim',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-3',
            'border-t border-surface-border bg-surface-elev-1 px-4 pb-5',
            'focus:outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4',
            className,
          )}
        >
          <div className='-mr-2 flex h-14 shrink-0 items-center justify-between gap-3'>
            <DialogPrimitive.Title className='font-display text-xl text-fg-high lowercase'>
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label='close'
              className='grid size-10 shrink-0 place-items-center text-fg-muted transition-colors hover:text-fg-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold'
            >
              <span className='i-lucide-x size-[18px]' aria-hidden='true' />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const SheetClose = DialogPrimitive.Close;
