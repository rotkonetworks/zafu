/**
 * you (Identity.dc.html): your seal, your card, and what knows you. The
 * generation key itself is never shown or handed out here: what travels is a
 * card (your own address and key for one person). The key, the generation
 * stepper and the backup live under "all identity controls".
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import {
  addZidPin,
  deriveRelationshipKeys,
  getZidIndex,
  mintRelationshipIndex,
  myDiscoveryKey,
  setZidIndex,
} from '../../../state/identity';
import {
  cardLinkPayload,
  contactCardMemoHex,
  myAddressForContact,
} from '../../../state/contact-share';
import {
  getDiversifiedAddresses,
  setDiversifiedAddresses,
} from '../../../state/diversified-addresses';
import { useContactAddressSource } from '../../../hooks/use-contact-address-source';
import { useShareCard } from '../../../hooks/use-share-card';
import { toUri } from '../../../links/router';
import { QrCode } from '../../../components/qr-code';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { identityLabel, useIdentity } from './use-identity';
import { hostOf, shortDay, useSites } from './site-list';

type Open = 'switch' | 'share' | 'qr' | 'new' | 'shared';

/**
 * Your card for one person, as a link: a fresh address and key each time it
 * is shown, so two people who scan it never hold the same one. The address
 * is recorded so a payment to it can be traced back to "a card you showed".
 */
const useCardLink = (open: boolean) => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const addressSource = useContactAddressSource();
  const [link, setLink] = useState<string | null>();

  useEffect(() => {
    if (!open || !keyInfo) {
      return;
    }
    setLink(undefined);
    let live = true;
    void (async () => {
      const one = crypto.randomUUID();
      const mine = await myAddressForContact(one, addressSource());
      const mnemonic = keyInfo.type === 'mnemonic' ? await getMnemonic(keyInfo.id) : undefined;
      // a fresh relationship for whoever scans this: their answer names it
      const gen = await getZidIndex(keyInfo.id);
      const rel = mnemonic
        ? deriveRelationshipKeys(mnemonic, gen, await mintRelationshipIndex(keyInfo.id, gen))
        : undefined;
      const ka = mnemonic && (await myDiscoveryKey(mnemonic));
      const hex =
        mine &&
        contactCardMemoHex({
          senderName: '',
          myAddress: mine.address,
          zid: rel?.pubkey,
          ka,
          pairKa: rel?.kaPublicKey,
        });
      if (!mine || !hex) {
        return live && setLink(null);
      }
      const records = await getDiversifiedAddresses();
      await setDiversifiedAddresses([
        ...records,
        {
          diversifierIndex: mine.index,
          sharedWith: 'a card you showed',
          address: mine.address,
          sharedAt: Date.now(),
        },
      ]);
      if (live) {
        setLink(toUri({ kind: 'contact', card: cardLinkPayload(hex) }));
      }
    })().catch(() => live && setLink(null));
    return () => {
      live = false;
    };
  }, [open, keyInfo, addressSource, getMnemonic]);

  return link;
};

const QrSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const link = useCardLink(open);
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='for one person'>
      <div className='flex flex-col items-center gap-3 pb-1'>
        {link ? (
          <>
            <QrCode value={link} size={220} label='your card' />
            <CopyButton
              text={link}
              label='copy link'
              variant='secondary'
              size='md'
              className='w-full'
            />
          </>
        ) : (
          <>
            <span
              className='size-[220px] border border-dashed border-border-hard'
              aria-hidden='true'
            />
            <span className='text-xs text-fg-muted'>
              {link === null
                ? 'sorry, zafu could not make your card. please unlock and try again.'
                : 'preparing your card'}
            </span>
          </>
        )}
      </div>
    </Sheet>
  );
};

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
            <span className='truncate font-display text-xl text-fg-high'>{label}</span>
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
            <Button variant='secondary' className='h-11 flex-1' onClick={() => setOpen('qr')}>
              show qr
            </Button>
          </div>
        )}

        <RowGroup>
          <Row
            type='value'
            label='sites that know you'
            value={String(sites.length)}
            onPress={() => navigate(PopupPath.IDENTITY_SITES)}
          />
          <Row
            type='value'
            label='passkeys and passwords'
            value={passkeys ? `${passkeys} passkey${passkeys === 1 ? '' : 's'}` : undefined}
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
      <QrSheet open={open === 'qr'} onClose={close} />
    </SettingsScreen>
  );
};

export default IdentityPage;
