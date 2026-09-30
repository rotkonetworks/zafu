import { useEffect, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';

/**
 * Recovery phrase display that starts covered. Until the user clicks to
 * reveal, the real words are not in the DOM at all (the blurred layer is
 * placeholder text), so a glance, a screenshot or a screen share of the
 * settings screen leaks nothing. Copy works without revealing.
 */
export const SeedPhraseBox = ({ phrase, className }: { phrase: string[]; className?: string }) => {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard.writeText(phrase.join(' ')).then(() => setCopied(true));
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className='relative rounded-lg bg-canvas border border-border-soft'>
        {revealed ? (
          <ol className='grid grid-cols-3 gap-x-2 gap-y-1 p-3 select-all cursor-text'>
            {phrase.map((word, i) => (
              <li key={i} className='flex items-baseline gap-1.5 text-xs'>
                <span className='w-4 shrink-0 text-right text-label tabular text-fg-dim'>
                  {i + 1}
                </span>
                <span className='text-fg-high'>{word}</span>
              </li>
            ))}
          </ol>
        ) : (
          <button
            type='button'
            onClick={() => setRevealed(true)}
            className='relative block w-full overflow-hidden rounded-lg'
          >
            <span
              aria-hidden
              className='grid grid-cols-3 gap-x-2 gap-y-1 p-3 blur-sm select-none pointer-events-none'
            >
              {phrase.map((_, i) => (
                <span key={i} className='text-xs text-fg-muted'>
                  {'•'.repeat(4 + ((i * 7) % 4))}
                </span>
              ))}
            </span>
            <span className='absolute inset-0 flex items-center justify-center gap-1.5 bg-canvas/40 text-xs text-fg-high'>
              <span className='i-ph-eye h-3.5 w-3.5' />
              click to reveal
            </span>
          </button>
        )}
      </div>
      <div className='flex items-center gap-4'>
        <button
          type='button'
          onClick={copy}
          className='inline-flex items-center gap-1.5 text-label text-fg-muted transition-colors hover:text-fg-high'
        >
          <span className={cn(copied ? 'i-ph-check' : 'i-ph-copy', 'h-3.5 w-3.5')} />
          {copied ? 'copied' : 'copy'}
        </button>
        {revealed && (
          <button
            type='button'
            onClick={() => setRevealed(false)}
            className='inline-flex items-center gap-1.5 text-label text-fg-muted transition-colors hover:text-fg-high'
          >
            <span className='i-ph-eye-slash h-3.5 w-3.5' />
            hide
          </button>
        )}
      </div>
    </div>
  );
};
