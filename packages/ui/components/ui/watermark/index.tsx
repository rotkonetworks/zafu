import type { CSSProperties } from 'react';
import { cn } from '../../../lib/utils';

/**
 * Watermark - a single faint kanji painted behind a screen's content.
 * Decoration only: it must never carry information a user needs to read,
 * and it must never sit in front of text.
 *
 * The parent needs `relative isolate` so this absolutely-positioned,
 * z-index: -1 glyph clips to it and stacks behind the parent's own
 * content instead of behind the whole page.
 *
 * Used in exactly three places (lock screen 守, home's first-sync wait
 * 間, about 道) - do not add it to send, review, sign, approval, error or
 * settings-list screens.
 */
export interface WatermarkProps {
  /** a single glyph from the bundled Shippori Mincho subset. */
  glyph: string;
  /** font size in px. default 220 - large enough to read as texture, not text. */
  size?: number;
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** px to pull the glyph past its corner, so it bleeds off the edge. default: a quarter of size. */
  offset?: number;
  className?: string;
}

export const Watermark = ({
  glyph,
  size = 220,
  corner = 'bottom-right',
  offset,
  className,
}: WatermarkProps) => {
  const edge = offset ?? -(size * 0.25);
  const position: CSSProperties = {
    position: 'absolute',
    zIndex: -1,
    fontSize: size,
    lineHeight: 1,
    opacity: 0.04,
    ...(corner.includes('top') ? { top: edge } : { bottom: edge }),
    ...(corner.includes('left') ? { left: edge } : { right: edge }),
  };

  return (
    <span
      aria-hidden='true'
      className={cn(
        'pointer-events-none select-none font-display font-semibold text-fg-high',
        className,
      )}
      style={position}
    >
      {glyph}
    </span>
  );
};
