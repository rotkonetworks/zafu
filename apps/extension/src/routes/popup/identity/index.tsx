/**
 * you (Identity.dc.html): your seal, your card, and what knows you. The
 * generation key itself is never shown or handed out here: what travels is a
 * card (your own address and key for one person). The key, the generation
 * stepper and the backup live under "all identity controls".
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { useStore } from '../../../state';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { addZidPin, setZidIndex } from '../../../state/identity';
import { useShareCard } from '../../../hooks/use-share-card';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { identityLabel, useIdentity } from './use-identity';
import { hostOf, shortDay, useSites } from './site-list';

type Open = 'switch' | 'share' | 'new' | 'shared' | 'rename';

const ShareSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();
  const shareCard = useShareCard();
  const contacts = useStore(s => s.contacts.contacts);
  const reachable = (Array.isArray(contacts) ? contacts : []).filter(c =>
    c.addresses.some(a => a.network === 'zcash'),
  );
  const [failed, setFailed] = useState(false);
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='share my card'>
      {reachable.length ? (
        <RowGroup className='max-h-64 overflow-y-auto'>
          {reachable.map(c => (
            <Row
              key={c.id}
              type='screen'
              label={c.name}
              onPress={() => void shareCard?.(c).then(ok => setFailed(!ok))}
            />
          ))}
        </RowGroup>
      ) : (
        <>
          <span className='text-xs text-fg-muted'>
            save someone first, then send them your card
          </span>
          <Button variant='secondary' onClick={() => navigate(`${PopupPath.CONTACTS}?add=1`)}>
            add someone
          </Button>
        </>
      )}
      {failed && (
        <span className='text-xs text-hanko-light'>
          sorry, zafu could not make an address for this card. please unlock and try again.
        </span>
      )}
    </Sheet>
  );
};

export const IdentityPage = () => {
  const navigate = useNavigate();
  const { keyInfo, walletId, zidIndex, zidPubkey, pins, label } = useIdentity();
  const { sites, log } = useSites();
  const [open, setOpen] = useState<Open>();
  const [name, setName] = useState('');
  const close = () => setOpen(undefined);
  const seeded = keyInfo?.type === 'mnemonic';
  const canCard = !!zidPubkey && !!keyInfo && keyInfoSupportsNetwork(keyInfo, 'zcash');
  const passkeys = sites.filter(s => s.perms?.granted.includes('passkey')).length;
  const known = [...new Set([0, zidIndex, ...pins.map(p => p.index)])].sort((a, b) => a - b);

  const makeIdentity = async () => {
    const next = Math.max(zidIndex, ...pins.map(p => p.index)) + 1;
    await addZidPin(walletId, next, name.trim());
    await setZidIndex(next, walletId);
    setName('');
    close();
  };

  return (
    <SettingsScreen
      title='you'
      backPath={PopupPath.INBOX}
      meta={
        zidPubkey &&
        seeded && (
          <button
            type='button'
            aria-label='switch identity'
            onClick={() => setOpen('switch')}
            className='flex h-8 items-center gap-1.5 border border-border-soft bg-elev-1 px-2.5 text-xs text-fg-high hover:bg-elev-2'
          >
            {label}
            <span className='i-lucide-chevron-down size-3 text-fg-muted' aria-hidden='true' />
          </button>
        )
      }
    >
      <div className='flex flex-col gap-4'>
        <div className='flex items-center gap-4 border border-border-hard bg-elev-1 p-4'>
          <ZidSeal hex={zidPubkey} size={66} tone='hanko' />
          <span className='flex min-w-0 flex-col gap-1'>
            {zidPubkey && seeded ? (
              <button
                type='button'
                aria-label={`rename ${label}`}
                onClick={() => {
                  setName(label);
                  setOpen('rename');
                }}
                className='flex items-center gap-2 text-left hover:text-zigner-gold'
              >
                <span className='truncate font-display text-xl text-fg-high'>{label}</span>
                <span
                  className='i-lucide-pencil size-3.5 shrink-0 text-fg-dim'
                  aria-hidden='true'
                />
              </button>
            ) : (
              <span className='truncate font-display text-xl text-fg-high'>{label}</span>
            )}
            <span className='text-[11px] text-fg-muted'>
              {zidPubkey
                ? 'your seal · compare it when you meet'
                : keyInfo?.type === 'zigner-zafu'
                  ? "this wallet's identity lives on your zigner"
                  : 'this wallet has no identity on this device'}
            </span>
          </span>
        </div>

        {canCard && (
          <div className='flex gap-2'>
            <Button className='h-11 flex-1' onClick={() => setOpen('share')}>
              share my card
            </Button>
            <Button
              variant='secondary'
              className='h-11 flex-1'
              onClick={() => navigate(PopupPath.INBOX_ADD)}
            >
              show qr
            </Button>
          </div>
        )}

        <RowGroup>
          <Row
            type='value'
            label='sites that know you'
            value={String(sites.length)}
            preload={PopupPath.IDENTITY_SITES}
            onPress={() => navigate(PopupPath.IDENTITY_SITES)}
          />
          <Row
            type='value'
            label='passkeys and passwords'
            value={passkeys ? `${passkeys} passkey${passkeys === 1 ? '' : 's'}` : undefined}
            preload={PopupPath.PASSWORDS}
            onPress={() => navigate(PopupPath.PASSWORDS)}
          />
          <Row
            type='value'
            label='keys shared with apps'
            value={String(log.length)}
            onPress={() => setOpen('shared')}
          />
        </RowGroup>

        <RowGroup>
          {zidPubkey && seeded && (
            <Row
              type='value'
              label='new identity'
              value='poker, work...'
              onPress={() => setOpen('new')}
            />
          )}
          <Row
            type='screen'
            label='all identity controls'
            preload={PopupPath.IDENTITY_CONTROLS}
            onPress={() => navigate(PopupPath.IDENTITY_CONTROLS)}
          />
        </RowGroup>
      </div>

      <Sheet open={open === 'switch'} onOpenChange={o => !o && close()} title='identities'>
        <RowGroup>
          {known.map(i => (
            <Row
              key={i}
              type='value'
              label={identityLabel(i, pins)}
              value={i === zidIndex ? 'now' : undefined}
              onPress={() => void setZidIndex(i, walletId).then(close)}
            />
          ))}
        </RowGroup>
      </Sheet>

      <Sheet open={open === 'new'} onOpenChange={o => !o && close()} title='new identity'>
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            void makeIdentity();
          }}
        >
          <Input
            aria-label='name'
            placeholder='poker, work...'
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <span className='text-[11px] text-fg-muted'>
            a new seal, unrelated to this one. you can switch back any time.
          </span>
          <Button type='submit' disabled={!name.trim()}>
            make it
          </Button>
        </form>
      </Sheet>

      <Sheet open={open === 'rename'} onOpenChange={o => !o && close()} title='rename'>
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            void addZidPin(walletId, zidIndex, name).then(() => {
              setName('');
              close();
            });
          }}
        >
          <Input
            aria-label='name'
            placeholder={zidIndex === 0 ? 'personal' : `identity ${zidIndex}`}
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <span className='text-[11px] text-fg-muted'>only you see this name</span>
          <Button type='submit'>save</Button>
        </form>
      </Sheet>

      <Sheet
        open={open === 'shared'}
        onOpenChange={o => !o && close()}
        title='keys shared with apps'
      >
        {log.length ? (
          <RowGroup className='max-h-72 overflow-y-auto'>
            {[...log].reverse().map((r, i) => (
              <Row
                key={`${r.sharedWith}-${r.sharedAt}-${i}`}
                type='value'
                label={hostOf(r.sharedWith)}
                value={shortDay(r.sharedAt)}
                onPress={() => void navigator.clipboard.writeText(r.publicKey)}
              />
            ))}
          </RowGroup>
        ) : (
          <span className='text-xs text-fg-muted'>no app holds a key of yours yet</span>
        )}
      </Sheet>

      <ShareSheet open={open === 'share'} onClose={close} />
    </SettingsScreen>
  );
};

export default IdentityPage;
