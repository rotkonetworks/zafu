/**
 * rendezvous-exchange — the human-code alternative to pasting relay keys.
 *
 * Default flow on relays that serve /rendezvous/* (zidecar does): the
 * coordinator shows a four-word code, co-signers type it in, and the key
 * exchange plus session-id handoff happens through the rendezvous room.
 * The coordinator still sees every joined key and nothing enters the frostd
 * session without their explicit "create" — the code is discovery, not
 * admission.
 *
 * The manual flow (paste relay keys, paste the session uuid) stays exactly
 * as it was, behind the "enter keys manually" toggle — and is forced when
 * the relay has no rendezvous.
 */

import { useEffect, useRef, useState } from 'react';
import {
  announceSession,
  generateRoomCode,
  hasRendezvous,
  pollRoom,
  publishKey,
  roomIdFromCode,
} from '../../../state/keyring/rendezvous-client';

const POLL_MS = 1000;

/**
 * null while probing, then whether the relay serves /rendezvous/*.
 * Stock frostd relays don't; the UI falls back to the manual flow.
 */
export function useRendezvousAvailable(relayUrl: string): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    void hasRendezvous(relayUrl).then(ok => {
      if (!cancelled) {
        setAvailable(ok);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);
  return available;
}

/** first 8 hex of a relay key — enough to eyeball against a chat message */
const fingerprint = (pubkey: string) => pubkey.slice(0, 8);

export interface HostRendezvous {
  /** the four words to send your co-signers */
  code: string;
  /** co-signer relay keys seen in the room, ours excluded */
  peerKeys: string[];
  /** after frostd session creation: hand joiners the uuid */
  announce: (sessionId: string) => Promise<void>;
}

interface HostProps {
  relayUrl: string;
  /** total signers including the host */
  maxSigners: number;
  /** create the relay identity and return our public key */
  prepare: () => Promise<string>;
  onState: (s: HostRendezvous) => void;
}

/** Coordinator side: show the code, watch keys arrive. */
export function RendezvousHost({
  relayUrl,
  maxSigners,
  prepare,
  onState,
}: HostProps): React.JSX.Element {
  const [code, setCode] = useState('');
  const [peers, setPeers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      try {
        const myKey = await prepare();
        // regenerate on collision: a code someone already used comes back
        // without a creator token, and a room we don't own is not ours to run
        let roomCode = '';
        let roomId = '';
        let token: string | null = null;
        for (let attempt = 0; attempt < 3 && token === null; attempt++) {
          roomCode = generateRoomCode();
          roomId = await roomIdFromCode(roomCode);
          token = await publishKey(relayUrl, roomId, myKey);
        }
        if (token === null) {
          throw new Error('could not open a rendezvous room');
        }
        if (stopped) {
          return;
        }
        setCode(roomCode);
        const creatorToken = token;

        const tick = async () => {
          const view = await pollRoom(relayUrl, roomId);
          const peerKeys = view.entries.map(e => e.pubkey).filter(k => k !== myKey);
          if (stopped) {
            return;
          }
          setPeers(peerKeys);
          onStateRef.current({
            code: roomCode,
            peerKeys,
            announce: sessionId => announceSession(relayUrl, roomId, creatorToken, sessionId),
          });
          timer = setTimeout(() => void tick().catch(fail), POLL_MS);
        };
        const fail = (e: unknown) => {
          if (!stopped) {
            setError(e instanceof Error ? e.message : String(e));
          }
        };
        await tick().catch(fail);
      } catch (e) {
        if (!stopped) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // one room per mount: relayUrl changes remount via the parent's key prop
  }, []);

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <div>
        <p className='text-xs text-fg-muted'>room code — send this to your co-signers</p>
        <div className='mt-1 flex items-center gap-2'>
          <span className='flex-1 rounded bg-input px-2 py-1.5 font-mono text-sm'>
            {code === '' ? 'opening room…' : code}
          </span>
          <button
            type='button'
            disabled={code === ''}
            className='shrink-0 rounded border border-border-soft px-2 py-1 text-xs disabled:opacity-40'
            onClick={() => {
              void navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      </div>

      <div className='flex flex-col gap-1'>
        <p className='text-xs text-fg-muted'>
          co-signers in the room: {peers.length} / {maxSigners - 1}
        </p>
        {peers.map(k => (
          <div key={k} className='flex items-center gap-2 text-xs'>
            <span className='i-ph-key size-3.5 text-fg-muted' />
            <span className='font-mono'>{fingerprint(k)}…</span>
          </div>
        ))}
        {peers.length >= maxSigners - 1 && (
          <p className='text-xs text-fg-muted'>
            check the fingerprints with your co-signers before you create — whoever holds these
            keys becomes a signer
          </p>
        )}
      </div>

      {error !== '' && <p className='text-xs text-red-400'>{error}</p>}
    </div>
  );
}

export interface JoinRendezvous {
  /** co-signer relay keys seen in the room, ours excluded */
  peerKeys: string[];
  /** the frostd session uuid, once the coordinator announces it */
  sessionId: string | null;
}

interface JoinProps {
  relayUrl: string;
  prepare: () => Promise<string>;
  onState: (s: JoinRendezvous) => void;
}

/** Joiner side: type the code, wait for the coordinator to start. */
export function RendezvousJoin({ relayUrl, prepare, onState }: JoinProps): React.JSX.Element {
  const [code, setCode] = useState('');
  const [connected, setConnected] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [announced, setAnnounced] = useState(false);
  const [error, setError] = useState('');
  const stopRef = useRef<(() => void) | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => () => stopRef.current?.(), []);

  const connect = async () => {
    setError('');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    stopRef.current?.();
    stopRef.current = () => {
      stopped = true;
      clearTimeout(timer);
    };
    try {
      const myKey = await prepare();
      const roomId = await roomIdFromCode(code);
      await publishKey(relayUrl, roomId, myKey);
      setConnected(true);

      const tick = async () => {
        const view = await pollRoom(relayUrl, roomId);
        const peerKeys = view.entries.map(e => e.pubkey).filter(k => k !== myKey);
        if (stopped) {
          return;
        }
        setPeerCount(peerKeys.length);
        setAnnounced(view.sessionId !== null);
        onStateRef.current({ peerKeys, sessionId: view.sessionId });
        timer = setTimeout(() => void tick().catch(fail), POLL_MS);
      };
      const fail = (e: unknown) => {
        if (!stopped) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };
      await tick().catch(fail);
    } catch (e) {
      if (!stopped) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <label className='text-xs text-fg-muted'>
        room code from the wallet creator
        <div className='mt-1 flex gap-2'>
          <input
            className='flex-1 rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-primary/50 focus:outline-none'
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder='four-words-like-these'
            disabled={connected}
            autoFocus
          />
          <button
            type='button'
            className='shrink-0 rounded border border-border-soft px-3 py-1 text-xs disabled:opacity-40'
            disabled={code.trim() === '' || connected}
            onClick={() => void connect()}
          >
            join
          </button>
        </div>
      </label>

      {connected && (
        <div className='flex items-center gap-2 text-xs text-fg-muted'>
          {announced ? (
            <span className='text-green-400'>session is ready</span>
          ) : (
            <>
              <span className='i-ph-circle-notch size-3.5 animate-spin' />
              in the room with {peerCount} other signer(s) — waiting for the coordinator to
              start…
            </>
          )}
        </div>
      )}

      {error !== '' && <p className='text-xs text-red-400'>{error}</p>}
    </div>
  );
}
