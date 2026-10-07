import type { ThreadItem } from '../../../people/vault';

/** what a line of yours says until it is on the relay; `sent` once it is */
export const SendState = ({
  item,
  say,
  sent,
}: {
  item: ThreadItem;
  /** "try again": the same line, under the same local id */
  say: (text: string, retry: string) => void;
  sent?: string;
}) => {
  const text =
    item.status === 'sending' ? 'sending' : item.status === 'waiting' ? 'waiting to send' : sent;
  if (item.status !== 'failed') {
    return text ? <span className='self-end text-[11px] text-fg-muted'>{text}</span> : null;
  }
  return (
    <span className='flex gap-2 self-end text-[11px] text-hanko-light'>
      this did not reach the relay
      <button
        type='button'
        className='text-zigner-gold hover:underline'
        onClick={() => say(item.kind === 'action' ? `/me ${item.body}` : item.body, item.local!)}
      >
        try again
      </button>
    </span>
  );
};
