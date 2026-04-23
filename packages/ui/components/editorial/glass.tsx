import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The Zafu "glass" primitive — a very dark, slightly cool translucent panel
 * with a 1px gold-tinted rim on top and a thin inner highlight. Never frosty
 * white: the canvas (#000) must still feel black behind it.
 *
 * Canonical use: approval sheets, modals, signed-payload surfaces. The rim
 * colour (gold by default) can be rebound for other chain accents by passing
 * `accent` — typically `var(--network-accent)`.
 *
 * Visual recipe ported verbatim from `components.html` (.glass).
 */
export interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Overrides the top border tint. Defaults to zigner-gold at 18% alpha. */
  accent?: string;
}

export const Glass = ({ children, className, accent, style, ...rest }: GlassProps) => (
  <div
    {...rest}
    className={cn(
      // the glass recipe — keep in sync with components.html .glass
      'rounded-md border border-[rgba(255,255,255,0.08)]',
      'backdrop-blur-[10px] backdrop-saturate-[140%]',
      className,
    )}
    style={{
      background:
        'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 40%),' +
        'linear-gradient(180deg, rgba(10,10,10,0.72) 0%, rgba(4,4,4,0.82) 100%)',
      borderTopColor: accent ?? 'rgba(244,183,40,0.18)',
      boxShadow:
        'inset 0 1px 0 rgba(255,255,255,0.04),' +
        'inset 0 -1px 0 rgba(0,0,0,0.5),' +
        '0 8px 24px -12px rgba(0,0,0,0.8)',
      ...style,
    }}
  >
    {children}
  </div>
);
