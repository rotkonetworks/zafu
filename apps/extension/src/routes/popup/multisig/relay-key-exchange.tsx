/**
 * relay-key-exchange — swap relay public keys before a session exists.
 *
 * This step is new, and it replaces the three-word room code as the thing you
 * send your co-signers. It exists because frostd lists a session's
 * participants at creation and admits nobody else, so there is no moment
 * later at which a key could be added.
 *
 * The trade is worth naming: a three-word code from a 256-word list is about
 * 2^24 guesses, and anyone who landed on one could previously join a DKG as a
 * participant — which is to say, become a signer on someone else's wallet.
 * An unlisted key now cannot send or receive at all.
 *
 * These are transport identities, not FROST ones, and not wallet keys. They
 * authenticate to the relay and key the encryption that stops it reading
 * anything. A fresh one is generated per ceremony so a relay operator cannot
 * link a user's sessions together.
 */

import { useEffect, useState } from 'react';

interface Props {
  /**
   * Total signers including this one, or 0 when it is not known yet.
   *
   * A joiner learns the group size from the DKG itself, which cannot start
   * until the keys are in — so when this is 0 the list grows on demand
   * instead of being fixed.
   */
  maxSigners: number;
  /** our own relay public key; '' until it has been generated */
  myKey: string;
  /** create the identity and return our public key */
  onPrepare: () => Promise<string>;
  onMyKey: (key: string) => void;
  onPeerKeys: (keys: string[]) => void;
}

export function RelayKeyExchange({
  maxSigners,
  myKey,
  onPrepare,
  onMyKey,
  onPeerKeys,
}: Props): React.JSX.Element {
  const [inputs, setInputs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  // generate our key as soon as the step is visible — the user cannot share
  // what has not been created, and this is the first thing they must do
  useEffect(() => {
    if (myKey !== '') {return;}
    void (async () => {
      try {
        onMyKey(await onPrepare());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'could not create a relay key');
      }
    })();
  }, [myKey, onPrepare, onMyKey]);

  const known = maxSigners > 1;

  // one input per co-signer when we know how many; otherwise start with one
  // and let the user add more
  useEffect(() => {
    const want = known ? maxSigners - 1 : 1;
    setInputs(prev => {
      if (known ? prev.length === want : prev.length >= want) {return prev;}
      const next = prev.slice(0, want);
      while (next.length < want) {next.push('');}
      return next;
    });
  }, [known, maxSigners]);

  const update = (i: number, value: string) => {
    const next = [...inputs];
    next[i] = value.trim();
    setInputs(next);
    onPeerKeys(next.filter(k => k !== ''));
  };

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <div>
        <p className='text-xs text-fg-muted'>your relay key — send this to your co-signers</p>
        <div className='mt-1 flex items-center gap-2'>
          <code className='flex-1 break-all rounded bg-input px-2 py-1.5 font-mono text-[10px]'>
            {myKey === '' ? 'generating…' : myKey}
          </code>
          <button
            type='button'
            disabled={myKey === ''}
            className='shrink-0 rounded border border-border-soft px-2 py-1 text-xs disabled:opacity-40'
            onClick={() => {
              void navigator.clipboard.writeText(myKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      </div>

      <div className='flex flex-col gap-2'>
        <p className='text-xs text-fg-muted'>
          {known
            ? `their relay keys — all ${maxSigners - 1} of them, before you continue`
            : 'their relay keys — one per co-signer, before you continue'}
        </p>
        {inputs.map((value, i) => (
          <input
            // index is stable here: the list length is driven by maxSigners
             
            key={i}
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-[10px] focus:border-primary/50 focus:outline-none'
            placeholder={`co-signer ${i + 1} relay key`}
            value={value}
            onChange={e => update(i, e.target.value)}
          />
        ))}
      </div>

      {!known && (
        <button
          type='button'
          className='self-start rounded border border-border-soft px-2 py-1 text-xs'
          onClick={() => setInputs(prev => [...prev, ''])}
        >
          + another co-signer
        </button>
      )}

      {error !== '' && <p className='text-xs text-red-400'>{error}</p>}
    </div>
  );
}
