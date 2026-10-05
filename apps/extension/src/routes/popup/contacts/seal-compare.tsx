/**
 * The pair seal as two people compare it: six words to read aloud (66 bits)
 * and a picture of 64 cells drawn from the seal, not mirrored, so every cell
 * counts. The small avatar seal elsewhere reads 15 bits and is a face, not a
 * check; this one is the check.
 */

import { cn } from '@repo/ui/lib/utils';
import { sealWords } from '../../../people/cards';

/** 64 cells, row by row: one bit each of the seal's first 16 hex characters */
export const sealGrid = (seal: string): boolean[] =>
  Array.from({ length: 64 }, (_, i) => {
    const nibble = parseInt(seal[i >> 2] ?? '0', 16) || 0;
    return ((nibble >> (3 - (i & 3))) & 1) === 1;
  });

export const SealCompare = ({ seal, done }: { seal?: string; done?: boolean }) => {
  const words = seal ? sealWords(seal) : [];
  return (
    <div className='flex flex-col items-center gap-4'>
      {seal ? (
        <span
          aria-hidden='true'
          className={cn(
            'grid grid-cols-8 gap-px border p-1.5',
            done ? 'border-hanko' : 'border-fg-muted',
          )}
        >
          {sealGrid(seal).map((on, i) => (
            <span
              key={i}
              className={cn('size-[13px]', on && (done ? 'bg-hanko' : 'bg-fg-muted'))}
            />
          ))}
        </span>
      ) : (
        <span className='size-[127px] border border-dashed border-border-hard' aria-hidden='true' />
      )}
      <ol
        aria-label='the seal, in six words'
        className='grid w-full grid-cols-3 border border-border-soft bg-elev-1'
      >
        {(words.length ? words : Array.from({ length: 6 }, () => '')).map((w, i) => (
          <li
            key={i}
            className='flex h-10 items-center gap-2 border-border-soft px-3 [&:nth-child(-n+3)]:border-b [&:not(:nth-child(3n))]:border-r'
          >
            <span className='text-[10px] text-fg-dim' aria-hidden='true'>
              {i + 1}
            </span>
            <span className='truncate font-mono text-sm text-fg-high'>{w}</span>
          </li>
        ))}
      </ol>
    </div>
  );
};
