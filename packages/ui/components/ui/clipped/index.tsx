import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn, shorten } from '../../../lib/utils';
import { Sheet } from '../sheet';
import { CopyButton } from '../copy-button';

const PRESSABLE = 'button, a, label, [role="button"], [role="link"], [role="option"]';

/**
 * Clipped - one line of text that may not fit. When it really is shortened,
 * the whole text stays reachable: `title` for hover, the full text for screen
 * readers, and a tap (or Enter) opens a sheet with it wrapped, selectable and
 * copyable. Text that fits renders plain, with no affordance.
 *
 * Two ways to shorten: by default CSS ellipsis at the end, measured against
 * the box; with `head` the middle goes (u1v9ga…qrdva), for addresses, ids and
 * hashes whose ends identify them.
 *
 * Inside something already pressable (a row, a button) the tap belongs to
 * that, so only the hover title and the accessible text remain.
 *
 * Never use this for a seed phrase - the sheet offers copy.
 */
export function Clipped({
  children,
  head,
  tail = head,
  label = 'in full',
  className,
}: {
  /** the full text; any node for end clipping, a string for middle */
  children: ReactNode;
  /** keep this many leading characters and drop the middle */
  head?: number;
  tail?: number;
  /** the sheet's heading */
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<string>();
  const [nested, setNested] = useState(false);
  const [open, setOpen] = useState(false);

  const middle = head !== undefined && typeof children === 'string' ? children : undefined;
  const short = middle === undefined ? undefined : shorten(middle, head, tail);
  const full = middle === undefined ? measured : short !== middle ? middle : undefined;

  // middle mode ignores the measure; one observer per span, not per render
  const measure = () => {
    const el = ref.current!;
    setNested(!!el.parentElement?.closest(PRESSABLE));
    setMeasured(el.scrollWidth > el.clientWidth ? el.textContent : undefined);
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  const pressable = full !== undefined && !nested;

  return (
    <span
      ref={ref}
      title={full}
      className={cn(
        middle === undefined && 'min-w-0 truncate',
        pressable &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold',
        className,
      )}
      role={pressable ? 'button' : undefined}
      tabIndex={pressable ? 0 : undefined}
      aria-haspopup={pressable ? 'dialog' : undefined}
      // the sheet is a react child, so its clicks and keys bubble up through here
      onClick={
        pressable
          ? e => {
              e.stopPropagation();
              if (e.currentTarget.contains(e.target as Node)) {
                setOpen(true);
              }
            }
          : undefined
      }
      onKeyDown={
        pressable
          ? e => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) {
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              setOpen(true);
            }
          : undefined
      }
    >
      {short === undefined || short === middle ? (
        children
      ) : (
        <>
          <span aria-hidden='true'>{short}</span>
          <span className='sr-only'>{middle}</span>
        </>
      )}
      {open && full !== undefined && (
        <Sheet open onOpenChange={setOpen} title={label}>
          <p className='select-text whitespace-pre-wrap text-sm text-fg-high [overflow-wrap:anywhere]'>
            {full}
          </p>
          <CopyButton text={full} label='copy' className='self-start' />
        </Sheet>
      )}
    </span>
  );
}
