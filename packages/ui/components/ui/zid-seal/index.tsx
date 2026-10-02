import { useMemo } from 'react';
import { cn } from '../../../lib/utils';

/**
 * ZidSeal - the 5x5 seal a public key draws (People / Identity / Contacts
 * boards). 15 bits of the key fill three columns, mirrored to five, so the
 * shape reads as a mark rather than noise and the same key always draws the
 * same seal. `tone`: hanko for you and the sites that know you, muted for
 * the people you saved. With no key it is a dashed empty square (an
 * address-only contact).
 */
export function ZidSeal({
  hex,
  size = 26,
  tone = 'muted',
  className,
}: {
  /** a public key as hex; at least 4 hex characters are read */
  hex?: string;
  /** outer px size; cells are (size - 6) / 5 */
  size?: number;
  tone?: 'hanko' | 'muted';
  className?: string;
}) {
  const cells = useMemo(() => (hex ? sealCells(hex) : undefined), [hex]);
  if (!cells) {
    return (
      <span
        aria-hidden='true'
        className={cn('shrink-0 border border-dashed border-border-hard', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const cell = Math.max(2, Math.floor((size - 6) / 5));
  return (
    <span
      aria-hidden='true'
      className={cn(
        'grid shrink-0 content-center justify-center border p-0.5',
        tone === 'hanko' ? 'border-hanko' : 'border-fg-muted',
        className,
      )}
      style={{ width: size, height: size, gridTemplateColumns: `repeat(5, ${cell}px)` }}
    >
      {cells.map((on, i) => (
        <span
          key={i}
          className={on ? (tone === 'hanko' ? 'bg-hanko' : 'bg-fg-muted') : undefined}
          style={{ width: cell, height: cell }}
        />
      ))}
    </span>
  );
}

/** 25 cells, row by row: bit (row * 3 + col) of the key for cols 0-2, mirrored for 3-4 */
export const sealCells = (hex: string): boolean[] => {
  const bits = parseInt(hex.slice(0, 4).padEnd(4, '0'), 16) || 0;
  return Array.from({ length: 25 }, (_, i) => {
    const row = Math.floor(i / 5);
    const col = i % 5;
    return ((bits >> (row * 3 + (col > 2 ? 4 - col : col))) & 1) === 1;
  });
};
