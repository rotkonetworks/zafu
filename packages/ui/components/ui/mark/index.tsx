import { cn } from '../../../lib/utils';

/**
 * Mark - the zafu brand mark. Every hand-drawn seal square or "zafu"
 * wordmark in the app routes through here, so it can never again go
 * invisible against its own background.
 *
 * seal   - filled vermillion square (the --hanko token, so it darkens for
 *          AA on washi paper) with a FIXED cream glyph (--mark-glyph -
 *          never a theme token, like real ink on a real hanko's paper).
 *          Pass `keyline` on busy art or photos for a 1px edge: cream on
 *          sumi, ink on washi. Never a shadow.
 * mono   - the glyph alone, or the "zafu" wordmark, in the theme's
 *          highest-contrast text colour (--fg-high). currentColor on a
 *          parent that sets the token, so it flips with the theme for
 *          free - cream on sumi, ink on washi.
 *          On busy art, the token alone is not enough: dark ink can still
 *          land on a dark patch of the art itself, theme be damned. Pass
 *          `keyline` there too - it adds a canvas-coloured halo (a text
 *          stroke, not a shadow) so the glyph separates from whatever is
 *          under it, not just from the page's own background.
 * lockup - seal to the left of the (always-mono) wordmark.
 */

const GLYPH = '匿';

export type MarkVariant = 'seal' | 'mono' | 'lockup';
export type MarkContent = 'glyph' | 'wordmark';

export interface MarkProps {
  variant?: MarkVariant;
  /** px size of the seal square. mono/lockup type scales off it too. */
  size?: number;
  /** mono only - the bare glyph or the "zafu" wordmark. default: glyph. */
  content?: MarkContent;
  /**
   * busy art or photos only. Seal: a 1px edge, cream on sumi, ink on washi.
   * Mono/lockup: a canvas-coloured text-stroke halo, so the wordmark reads
   * against the art under it, not just against the page.
   */
  keyline?: boolean;
  /**
   * seal only - override the stamped glyph for a non-brand use of the same
   * hanko-square language (e.g. a "done" stamp). Defaults to the brand
   * glyph; most callers never pass this.
   */
  glyph?: string;
  className?: string;
}

const Seal = ({
  size = 38,
  keyline = false,
  glyph = GLYPH,
  className,
}: Pick<MarkProps, 'size' | 'keyline' | 'glyph' | 'className'>) => (
  <span
    aria-hidden='true'
    className={cn(
      'inline-flex shrink-0 items-center justify-center bg-hanko font-display font-semibold text-mark-glyph',
      keyline && 'ring-1 ring-inset ring-fg-high',
      className,
    )}
    style={{ width: size, height: size, fontSize: (size ?? 38) * 0.55 }}
  >
    {glyph}
  </span>
);

const Mono = ({
  size = 38,
  content = 'glyph',
  keyline = false,
  className,
}: Pick<MarkProps, 'size' | 'content' | 'keyline' | 'className'>) => (
  <span
    aria-hidden={content === 'glyph' ? 'true' : undefined}
    className={cn(
      'inline-flex shrink-0 items-center font-display font-semibold text-fg-high',
      className,
    )}
    style={{
      fontSize: content === 'glyph' ? (size ?? 38) * 0.75 : (size ?? 38) * 0.68,
      ...(keyline
        ? { WebkitTextStroke: '3px var(--surface-canvas)', paintOrder: 'stroke fill' }
        : null),
    }}
  >
    {content === 'glyph' ? GLYPH : 'zafu'}
  </span>
);

export const Mark = ({
  variant = 'lockup',
  size = 38,
  content,
  keyline,
  glyph,
  className,
}: MarkProps) => {
  if (variant === 'seal') {
    return <Seal size={size} keyline={keyline} glyph={glyph} className={className} />;
  }
  if (variant === 'mono') {
    return (
      <Mono size={size} content={content ?? 'glyph'} keyline={keyline} className={className} />
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Seal size={size} keyline={keyline} glyph={glyph} />
      <Mono size={size} content='wordmark' keyline={keyline} />
    </span>
  );
};
