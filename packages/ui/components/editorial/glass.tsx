import { HTMLAttributes, ReactNode, CSSProperties } from 'react';
import { cn } from '../../lib/utils';

/**
 * The Zafu "glass" primitive — a very dark, slightly cool translucent panel
 * with a 1px gold-tinted rim on top and a thin inner highlight. Never frosty
 * white: the canvas (#000) must still feel black behind it.
 *
 * The actual recipe lives in `packages/tailwind-config/index.css` under
 * `@utility glass-surface`. This component just applies the class and
 * (optionally) rebinds `--glass-accent` on a per-instance basis.
 *
 * Canonical use: approval sheets, modals, signed-payload surfaces. The rim
 * colour (gold by default) can be rebound per-chain by passing `accent` —
 * typically `"var(--network-accent)"` or an rgba() literal.
 */
export interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Overrides the top-rim colour. Defaults to zigner-gold at 18% alpha. */
  accent?: string;
}

// The accent custom property is part of the public CSS contract of
// `glass-surface`, so typing `style` needs to tolerate it.
interface GlassStyle extends CSSProperties {
  '--glass-accent'?: string;
}

export const Glass = ({ children, className, accent, style, ...rest }: GlassProps) => {
  const mergedStyle: GlassStyle = accent
    ? { '--glass-accent': accent, ...style }
    : (style ?? {});
  return (
    <div {...rest} className={cn('glass-surface', className)} style={mergedStyle}>
      {children}
    </div>
  );
};
