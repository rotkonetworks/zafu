/**
 * group-chat-thread - the coordination chat for one multisig group.
 *
 * Realtime while open: it opens the group's frostd chat session on mount and
 * stops polling on unmount. Messages that arrived while the popup was closed
 * are drained from the relay's per-recipient queue on open (frostd holds them
 * up to a day). Durable cross-session delivery is a later brick; for now a peer
 * offline past that window may miss a message.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { groupChatSelector, type GroupChatMessage } from '../../../state/group-chat';
import { selectMultisigWallets } from '../../../state/wallets';
import { PopupPath } from '../paths';

/** short label for a peer relay pubkey, so distinct co-signers are tellable apart. */
const shortPub = (hex: string): string => (hex ? hex.slice(0, 6) : 'peer');

const timeLabel = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function GroupChatThread() {
  const navigate = useNavigate();
  const { walletId = '' } = useParams();
  const { openChat, sendChat, closeChat } = useStore(groupChatSelector);
  const thread = useStore(s => s.groupChat.threads[walletId]);
  const wallets = useStore(selectMultisigWallets);
  const wallet = useMemo(() => wallets.find(w => w.id === walletId), [wallets, walletId]);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!walletId) {
      return;
    }
    void openChat(walletId);
    return () => closeChat(walletId);
  }, [walletId, openChat, closeChat]);

  // keep the newest message in view
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) {
      return;
    }
    setSending(true);
    try {
      await sendChat(walletId, text);
      setDraft('');
    } finally {
      setSending(false);
    }
  };

  const messages = thread?.messages ?? [];
  const status = thread?.status ?? 'idle';

  return (
    <div className='flex h-full flex-col'>
      <header className='flex items-center gap-2 border-b border-border-soft px-3 py-3'>
        <button
          type='button'
          onClick={() => navigate(PopupPath.INBOX)}
          className='i-ph-arrow-left h-5 w-5 shrink-0 text-fg-muted hover:text-fg-high'
          aria-label='back'
        />
        <div className='flex min-w-0 flex-col'>
          <span className='truncate text-sm text-fg-high lowercase'>
            {wallet?.label ?? 'group chat'}
          </span>
          <span className='text-label text-fg-dim'>
            {status === 'live' && 'connected'}
            {status === 'connecting' && 'connecting…'}
            {status === 'error' && (thread?.error ?? 'not connected')}
            {status === 'idle' && 'multisig group'}
          </span>
        </div>
      </header>

      <div className='flex-1 space-y-2 overflow-y-auto p-3'>
        {status === 'error' && (
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3 text-label text-amber-400'>
            {thread?.error}
          </div>
        )}
        {messages.length === 0 && status !== 'error' && (
          <p className='mt-8 text-center text-label text-fg-dim'>
            no messages yet. say hi to your co-signers to coordinate a signing.
          </p>
        )}
        {messages.map(m => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>

      <div className='flex items-end gap-2 border-t border-border-soft p-3'>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder='message the group…'
          className='max-h-24 flex-1 resize-none rounded-lg border border-border-soft bg-canvas px-3 py-2 text-sm text-fg-high placeholder:text-fg-dim focus:outline-none'
        />
        <button
          type='button'
          onClick={() => void send()}
          disabled={!draft.trim() || sending || status === 'error'}
          className='rounded-lg bg-network-accent px-3 py-2 text-sm font-medium text-network-accent-foreground disabled:opacity-40'
        >
          send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: GroupChatMessage }) {
  return (
    <div className={m.mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          m.mine
            ? 'max-w-[80%] rounded-lg rounded-br-sm bg-network-accent px-3 py-1.5 text-sm text-network-accent-foreground'
            : 'max-w-[80%] rounded-lg rounded-bl-sm bg-elev-1 px-3 py-1.5 text-sm text-fg-high'
        }
      >
        {!m.mine && (
          <span className='mb-0.5 block font-mono text-label text-network-accent'>
            {shortPub(m.senderPub)}
          </span>
        )}
        <span className='whitespace-pre-wrap break-words'>{m.body}</span>
        <span
          className={
            m.mine
              ? 'mt-0.5 block text-right text-label text-network-accent-foreground/70'
              : 'mt-0.5 block text-right text-label text-fg-dim'
          }
        >
          {timeLabel(m.recvTs)}
        </span>
      </div>
    </div>
  );
}
