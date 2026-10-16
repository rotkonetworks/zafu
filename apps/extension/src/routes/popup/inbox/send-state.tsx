import { cn } from '@repo/ui/lib/utils';
import type { ThreadItem } from '../../../people/vault';
import { sendLine } from './chat';

/** where a line of yours stands; with `sent`, a line on the relay says so */
export const SendState = ({
  item,
  say,
  sent,
}: {
  item: ThreadItem;
  /** "try again": the same line, under the same local id */
  say: (text: string, retry: string) => void;
  sent?: boolean;
}) => {
  const line = sendLine(item, sent);
  if (!line) {
    return null;
  }
  return (
    <span
      className={cn(
        '-mt-1.5 flex items-center gap-1.5 self-end text-[11px]',
        line.tone === 'failed' ? 'text-hanko-light' : 'text-fg-muted',
      )}
    >
      {line.mark && <span className='size-1.5 border border-fg-muted' aria-hidden='true' />}
      {line.text}
      {line.tone === 'failed' && (
        <button
          type='button'
          className='text-zigner-gold hover:underline'
          onClick={() => say(item.kind === 'action' ? `/me ${item.body}` : item.body, item.local!)}
        >
          try again
        </button>
      )}
    </span>
  );
};
