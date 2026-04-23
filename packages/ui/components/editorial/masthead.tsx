import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Editorial masthead — the section-opening title row used at the top of pages
 * and preview sheets. Two columns: identity on the left (kicker + title),
 * meta on the right (timestamps, revision, stats). Bottom-anchored, with a
 * 1px rule below.
 *
 *   <Masthead
 *     kicker="zafu // v0.4"
 *     title={<>palette <Separator/> <Accent>terminal dark</Accent></>}
 *     meta={<><b>rev</b> 2026.04.23</>}
 *   />
 */
export interface MastheadProps {
  /** Small uppercase dim label above the title. */
  kicker?: ReactNode;
  /** The h1 content. Wrap any accented spans with <Masthead.Accent>. */
  title: ReactNode;
  /** Right column — typically a stack of <b>label</b> value lines. */
  meta?: ReactNode;
  className?: string;
}

export const Masthead = ({ kicker, title, meta, className }: MastheadProps) => (
  <header
    className={cn(
      'grid grid-cols-[1fr_auto] gap-6 items-end pb-5 mb-8 border-b border-border-hard',
      className,
    )}
  >
    <div className='flex flex-col gap-1.5'>
      {kicker && <div className='kicker'>{kicker}</div>}
      <h1 className='text-[36px] text-fg-high leading-none tracking-[-0.01em]'>{title}</h1>
    </div>
    {meta && (
      <div className='tabular text-[10px] text-fg-dim leading-[1.7] text-right'>{meta}</div>
    )}
  </header>
);

/** Thin separator between title fragments. Use as a child of the <Masthead> title. */
Masthead.Sep = ({ children = '·' }: { children?: ReactNode }) => (
  <span className='text-fg-dim mx-2.5'>{children}</span>
);

/** Gold-accented title fragment (typically the network / brand word). */
Masthead.Accent = ({ children }: { children: ReactNode }) => (
  <span className='text-zigner-gold'>{children}</span>
);
