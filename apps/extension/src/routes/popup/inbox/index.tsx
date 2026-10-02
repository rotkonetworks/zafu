/**
 * people (People.dc.html): you, the one thing that needs you (only when
 * something does), your groups with their balance, then direct threads by
 * recency.
 *
 * Opening this tab is T1 of the no-autoconnect contract: the chain memos the
 * light client already syncs, plus one catch-up pass over the rooms this
 * wallet joined on the people relay. With no rooms that pass is nothing at
 * all: no request, no question. No discovery runs from here.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { cn } from '@repo/ui/lib/utils';
import { useStore, type AllSlices } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { selectVisibleMultisigWallets, type ZcashWalletJson } from '../../../state/wallets';
import { usePenumbraMemos } from '../../../hooks/penumbra-memos';
import { useZcashMemos } from '../../../hooks/zcash-memos';
import { useMultisigBalances } from '../../../hooks/multisig-balances';
import { ScreenHeader } from '../../../components/screen-header';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath, threadPath } from '../paths';
import { useIdentity } from '../identity/use-identity';
import { deriveThreads, previewOf, shortAddress, whenOf, type DirectThread } from './threads';
import { useThreadName } from './use-thread-name';
import { useOpenPeople } from '../../../people/client';

const zec = (zat: bigint) => (Number(zat) / 1e8).toFixed(2);

const Chevron = ({ tone = 'text-fg-dim' }: { tone?: string }) => (
  <span className={cn('i-lucide-chevron-right size-3.5 shrink-0', tone)} aria-hidden='true' />
);

const YouRow = () => {
  const navigate = useNavigate();
  const { zidPubkey, label } = useIdentity();
  return (
    <button
      type='button'
      onClick={() => navigate(PopupPath.IDENTITY)}
      className='flex items-center gap-3.5 border border-border-soft bg-elev-1 px-3.5 py-3 text-left transition-colors hover:bg-elev-2'
    >
      <ZidSeal hex={zidPubkey} size={36} tone='hanko' />
      <span className='flex min-w-0 grow flex-col gap-[3px]'>
        <span className='truncate text-sm text-fg-high'>you · {label}</span>
        <span className='text-[11px] text-fg-muted'>your card, sites, passkeys</span>
      </span>
      <Chevron />
    </button>
  );
};

/** the one fixed slot: rendered only while something waits for you */
const NeedsYou = () => {
  const navigate = useNavigate();
  const signing = useStore(s => s.frostSession.signing);
  const dkg = useStore(s => s.frostSession.dkg);
  const item =
    signing && signing.step !== 'complete' && !signing.error
      ? {
          title: 'needs your seal',
          line: 'a group payment is waiting',
          to: PopupPath.MULTISIG_SIGN,
        }
      : dkg && dkg.round < 3 && !dkg.error
        ? {
            title: 'a group is being made',
            line: 'its keys are made together',
            to: PopupPath.MULTISIG,
          }
        : undefined;
  if (!item) {
    return null;
  }
  return (
    <button
      type='button'
      onClick={() => navigate(item.to)}
      className='flex items-center gap-3 border border-hanko bg-hanko/10 p-3.5 text-left transition-colors hover:bg-hanko/15'
    >
      <span className='flex size-[34px] shrink-0 -rotate-6 items-center justify-center border-2 border-hanko font-display text-lg font-semibold text-hanko'>
        判
      </span>
      <span className='flex min-w-0 grow flex-col gap-[3px]'>
        <span className='text-[13px] text-fg-high'>{item.title}</span>
        <span className='truncate text-[11px] text-fg-muted'>{item.line}</span>
      </span>
      <Chevron tone='text-fg-muted' />
    </button>
  );
};

const GroupRow = memo(({ wallet, balance }: { wallet: ZcashWalletJson; balance?: bigint }) => {
  const navigate = useNavigate();
  const ms = wallet.multisig!;
  return (
    <button
      type='button'
      onClick={() =>
        navigate(
          ms.relayPeerKeys?.length
            ? PopupPath.INBOX_GROUP.replace(':walletId', wallet.id)
            : PopupPath.MULTISIG,
        )
      }
      className='flex h-16 items-center gap-3 px-1 text-left transition-colors hover:bg-elev-2'
    >
      <span className='flex size-10 shrink-0 items-center justify-center border border-border-hard bg-elev-1 font-display text-lg text-zigner-gold'>
        蔵
      </span>
      <span className='flex min-w-0 grow items-baseline gap-2'>
        <span className='truncate text-sm text-fg-high lowercase'>{wallet.label}</span>
        <span className='shrink-0 text-[11px] text-fg-muted'>
          {ms.threshold} of {ms.maxSigners}
        </span>
      </span>
      {balance !== undefined && (
        <Sensitive className='text-[13px] text-fg-high tabular'>{zec(balance)}</Sensitive>
      )}
    </button>
  );
});
GroupRow.displayName = 'GroupRow';

const Groups = () => {
  const wallets = useStore(selectVisibleMultisigWallets);
  const onZcash = useStore(s => selectActiveNetwork(s) === 'zcash');
  const balances = useMultisigBalances(wallets, onZcash);
  if (!wallets.length) {
    return null;
  }
  return (
    <section className='flex flex-col gap-1.5'>
      <h2 className='text-xs tracking-[0.04em] text-fg-muted'>groups</h2>
      <div className='flex flex-col'>
        {wallets.map(w => (
          <GroupRow key={w.id} wallet={w} balance={balances[w.id]} />
        ))}
      </div>
    </section>
  );
};

const DirectRow = memo(({ thread }: { thread: DirectThread }) => {
  const navigate = useNavigate();
  const name = useThreadName(thread.address);
  const unread = thread.unread > 0;
  return (
    <button
      type='button'
      onClick={() => navigate(threadPath(thread.id))}
      className='flex h-[60px] items-center gap-3 px-1 text-left transition-colors hover:bg-elev-2'
    >
      <span className='flex size-10 shrink-0 items-center justify-center bg-elev-2 text-[15px] text-fg-high lowercase'>
        {name.charAt(0)}
      </span>
      <span className='flex min-w-0 grow flex-col gap-[3px]'>
        <span className={cn('truncate text-sm', unread ? 'text-fg-high' : 'text-fg')}>{name}</span>
        <span className='truncate text-[11px] text-fg-muted'>{previewOf(thread.last)}</span>
      </span>
      <span className='flex shrink-0 flex-col items-end gap-1'>
        <span className='text-[11px] text-fg-dim'>{whenOf(thread.last.timestamp)}</span>
        {unread && <span className='size-2 bg-zigner-gold' aria-label='unread' />}
      </span>
    </button>
  );
});
DirectRow.displayName = 'DirectRow';

const selectThreads = (s: AllSlices) => s.messages.messages;

const Direct = ({ canCard }: { canCard: boolean }) => {
  const navigate = useNavigate();
  const network = useStore(selectActiveNetwork);
  const messages = useStore(selectThreads);
  const threads = useMemo(
    () =>
      deriveThreads((Array.isArray(messages) ? messages : []).filter(m => m.network === network)),
    [messages, network],
  );
  return (
    <section className='flex flex-col gap-1.5'>
      <div className='flex items-baseline justify-between'>
        <h2 className='text-xs tracking-[0.04em] text-fg-muted'>direct</h2>
        <button
          type='button'
          onClick={() => navigate(PopupPath.CONTACTS)}
          className='text-xs text-zigner-gold hover:underline'
        >
          contacts
        </button>
      </div>
      {threads.length ? (
        <div className='flex flex-col'>
          {threads.map(t => (
            <DirectRow key={t.id} thread={t} />
          ))}
        </div>
      ) : (
        <div className='flex flex-col items-start gap-3 py-4'>
          <span className='text-[13px] text-fg-muted'>no one here yet</span>
          <div className='flex gap-2'>
            {canCard && (
              <Button variant='secondary' size='sm' onClick={() => navigate(PopupPath.IDENTITY)}>
                share my card
              </Button>
            )}
            <Button
              variant='secondary'
              size='sm'
              onClick={() => navigate(`${PopupPath.CONTACTS}?add=1`)}
            >
              add someone
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};

/** new message: pick someone saved, or paste an address */
const NewMessageSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();
  const network = useStore(selectActiveNetwork);
  const contacts = useStore(s => s.contacts.contacts);
  const people = useMemo(
    () =>
      (Array.isArray(contacts) ? contacts : []).flatMap(contact =>
        contact.addresses.filter(a => a.network === network).map(address => ({ contact, address })),
      ),
    [contacts, network],
  );
  const [address, setAddress] = useState('');
  const go = (to: string) => {
    onClose();
    navigate(threadPath(to.trim().toLowerCase()));
  };
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='new message'>
      {people.length > 0 && (
        <div className='flex max-h-60 flex-col overflow-y-auto border border-border-soft bg-elev-1'>
          {people.map(({ contact, address: a }) => (
            <button
              key={a.id}
              type='button'
              onClick={() => go(a.address)}
              className='flex h-12 items-center gap-3 border-b border-border-soft px-3.5 text-left last:border-0 hover:bg-elev-2'
            >
              <span className='grow truncate text-sm text-fg-high'>{contact.name}</span>
              <span className='text-[11px] text-fg-muted'>{shortAddress(a.address)}</span>
            </button>
          ))}
        </div>
      )}
      <form
        className='flex gap-2'
        onSubmit={e => {
          e.preventDefault();
          if (address.trim()) {
            go(address);
          }
        }}
      >
        <Input
          aria-label='address'
          placeholder='or paste an address'
          value={address}
          onChange={e => setAddress(e.target.value)}
          className='grow font-mono text-xs'
        />
        <Button type='submit' variant='primary' disabled={!address.trim()}>
          open
        </Button>
      </form>
    </Sheet>
  );
};

export function InboxPage() {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const network = useStore(selectActiveNetwork);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const walletId = keyInfo?.id ?? '';
  const [composing, setComposing] = useState(false);
  const canCard = !!keyInfo && keyInfoSupportsNetwork(keyInfo, 'zcash');

  useOpenPeople();
  // the chain memos the light client already reads
  const { syncMemos: syncPenumbra } = usePenumbraMemos(walletId);
  const { syncMemos: syncZcash } = useZcashMemos(walletId, zidecarUrl);
  useEffect(() => {
    if (network === 'penumbra') {
      syncPenumbra();
    } else if (network === 'zcash' && walletId) {
      syncZcash();
    }
  }, [network, walletId, syncPenumbra, syncZcash]);

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader
        title='people'
        backPath={false}
        meta={
          <>
            <button
              type='button'
              aria-label='new group'
              onClick={() => navigate(PopupPath.MULTISIG_CREATE)}
              className='flex h-9 items-center gap-1.5 border border-border-soft px-2.5 text-xs text-fg-high transition-colors hover:bg-elev-2'
            >
              <span className='i-zafu-torii size-[15px]' aria-hidden='true' />
              new group
            </button>
            <button
              type='button'
              aria-label='new message'
              onClick={() => setComposing(true)}
              className='grid size-10 place-items-center text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high'
            >
              <span className='i-lucide-pencil size-[18px]' aria-hidden='true' />
            </button>
          </>
        }
      />
      <div className='flex flex-col gap-[18px] px-4 pb-4 pt-3.5'>
        <YouRow />
        <NeedsYou />
        <Groups />
        <Direct canCard={canCard} />
      </div>
      <NewMessageSheet open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}

export default InboxPage;
