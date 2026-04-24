import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * A hairline horizontal rule — the `<Rule/>` element used as a visual
 * break inside editorial layouts (inside `<SectionHead>`, between
 * scale rows, etc). Thin, colored by the v2 border token, full-width.
 */
export const Rule = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div {...rest} className={cn('rule', className)} />
);

/**
 * `<RulerScale>` — the drawn-ruler spacing visualisation from `spacing.html`.
 * Shows the design system's spacing scale as a horizontal ruler with ticks,
 * gold majors, and labeled segments. Useful for internal docs / storybook.
 */
export interface RulerScaleProps {
  /** Total reach of the ruler in px (default 300, matching the preview). */
  max?: number;
  /** Tick values to render. Major ticks are highlighted in gold. */
  ticks?: Array<{ v: number; major?: boolean; label?: ReactNode }>;
  /** Named segments drawn below the rule. */
  segments?: Array<{ from: number; to: number; label: ReactNode }>;
  className?: string;
}

export const RulerScale = ({
  max = 300,
  ticks = [
    { v: 0, major: true, label: '0' },
    { v: 4 },
    { v: 8 },
    { v: 12 },
    { v: 16, major: true, label: '16' },
    { v: 20 },
    { v: 24 },
    { v: 32, major: true, label: '32' },
    { v: 48, major: true, label: '48' },
  ],
  segments = [],
  className,
}: RulerScaleProps) => {
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <div
      className={cn(
        'relative bg-[#050505] border border-border-hard rounded-sm overflow-hidden',
        'pt-18 pb-6 px-8',
        className,
      )}
      style={{ paddingTop: 72 }}
    >
      {/* dashed axis */}
      <div
        className='absolute inset-x-8 top-11 h-px'
        style={{
          background:
            'repeating-linear-gradient(90deg, var(--surface-border-soft) 0 1px, transparent 1px 4px)',
        }}
      />
      {ticks.map(t => (
        <div
          key={t.v}
          className={cn(
            'absolute top-11 w-px',
            t.major ? 'bg-zigner-gold h-4' : 'bg-fg-dim h-3',
          )}
          style={{ left: pct(t.v) }}
        >
          {t.label && (
            <div
              className={cn(
                'absolute bottom-[18px] left-1/2 -translate-x-1/2',
                'text-[10px] whitespace-nowrap tabular',
                t.major ? 'text-zigner-gold' : 'text-fg-dim',
              )}
            >
              {t.label}
            </div>
          )}
        </div>
      ))}
      {segments.map((s, i) => (
        <div
          key={i}
          className='absolute h-2 rounded-sm'
          style={{
            top: 62,
            left: pct(s.from),
            width: pct(s.to - s.from),
            background: 'linear-gradient(90deg, var(--zigner-gold-dark), var(--zigner-gold))',
          }}
        >
          <div
            className='absolute top-[18px] left-1/2 -translate-x-1/2 text-[10px] text-fg whitespace-nowrap'
          >
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
};
