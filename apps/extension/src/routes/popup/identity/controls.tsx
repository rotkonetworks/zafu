/**
 * all identity controls: the generation you present (step back or on, name
 * it), its public key, and the encrypted file that carries your people,
 * notes and settings to another device. Everything here is a row or a sheet;
 * nothing opens in place.
 */

import { useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import type { PersonalDataBackup } from '../../../state/contacts';
import {
  addZidPin,
  removeZidPin,
  rotateZidIndex,
  rotateZidIndexDown,
} from '../../../state/identity';
import { Section, SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { useIdentity } from './use-identity';

type Open = 'generation' | 'name' | 'backup' | 'restore';

const download = (data: PersonalDataBackup) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `zafu-personal-data-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
};

const BackupSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const exportPersonalData = useStore(s => s.contacts.exportPersonalData);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string>();
  const ok = pass.length >= 8 && pass === again;
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='back up to a file'>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          void exportPersonalData(pass).then(
            data => {
              download(data);
              onClose();
            },
            () => setError('something broke on our side, not yours. nothing was lost.'),
          );
        }}
      >
        <Input
          type='password'
          aria-label='backup passphrase'
          placeholder='backup passphrase'
          value={pass}
          onChange={e => setPass(e.target.value)}
          autoFocus
        />
        <Input
          type='password'
          aria-label='again'
          placeholder='again'
          value={again}
          onChange={e => setAgain(e.target.value)}
        />
        <span className='text-[11px] text-fg-muted'>
          not your wallet password · 8 characters or more · people, notes and settings
        </span>
        {error && <span className='text-xs text-hanko-light'>{error}</span>}
        <Button type='submit' disabled={!ok}>
          save backup file
        </Button>
      </form>
    </Sheet>
  );
};

const RestoreSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const importPersonalData = useStore(s => s.contacts.importPersonalData);
  const file = useRef<HTMLInputElement>(null);
  const [pass, setPass] = useState('');
  const [line, setLine] = useState<string>();
  const restore = async () => {
    const f = file.current?.files?.[0];
    if (!f) {
      return;
    }
    try {
      const n = await importPersonalData(
        JSON.parse(await f.text()) as PersonalDataBackup,
        pass,
        'merge',
      );
      setLine(`restored ${n.contacts} contacts, ${n.sent} sends, ${n.notes} notes`);
    } catch {
      setLine('this file did not open with that passphrase. nothing was changed.');
    }
  };
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='restore from a file'>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          void restore();
        }}
      >
        <input
          ref={file}
          type='file'
          accept='.json'
          aria-label='backup file'
          className='text-xs text-fg-muted'
        />
        <Input
          type='password'
          aria-label='backup passphrase'
          placeholder='backup passphrase'
          value={pass}
          onChange={e => setPass(e.target.value)}
        />
        {line && <span className='text-xs text-fg-muted'>{line}</span>}
        <Button type='submit' disabled={!pass}>
          restore
        </Button>
      </form>
    </Sheet>
  );
};

export const IdentityControlsPage = () => {
  const { keyInfo, walletId, zidIndex, zidPubkey, pins, label } = useIdentity();
  const [open, setOpen] = useState<Open>();
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const close = () => setOpen(undefined);
  const seeded = keyInfo?.type === 'mnemonic';
  const pinned = pins.some(p => p.index === zidIndex);

  return (
    <SettingsScreen title='all identity controls' backPath={PopupPath.IDENTITY}>
      <div className='flex flex-col gap-4'>
        {zidPubkey && (
          <Section title='this identity'>
            {seeded && (
              <Row
                type='value'
                label='generation'
                value={String(zidIndex)}
                onPress={() => setOpen('generation')}
              />
            )}
            {seeded && (
              <Row
                type='value'
                label='name'
                value={label}
                onPress={() => {
                  setName(pinned ? label : '');
                  setOpen('name');
                }}
              />
            )}
            {seeded && pinned && (
              <Row
                type='toggle'
                label='keep in the switcher'
                checked={pinned}
                onChange={() => void removeZidPin(walletId, zidIndex)}
              />
            )}
            <Row
              type='value'
              label='public key'
              value={copied ? 'copied' : `${zidPubkey.slice(0, 8)}…${zidPubkey.slice(-4)}`}
              onPress={() =>
                void navigator.clipboard.writeText(zidPubkey).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            />
          </Section>
        )}

        <Section title='your people and settings'>
          <Row type='screen' label='back up to a file' onPress={() => setOpen('backup')} />
          <Row type='screen' label='restore from a file' onPress={() => setOpen('restore')} />
        </Section>
      </div>

      <Sheet
        open={open === 'generation'}
        onOpenChange={o => !o && close()}
        title={`generation ${zidIndex}`}
      >
        <span className='text-[11px] text-fg-muted'>
          each generation is a different seal from the same recovery phrase. stepping back brings an
          old one back exactly.
        </span>
        <div className='flex gap-2'>
          <Button
            variant='secondary'
            className='flex-1'
            disabled={zidIndex === 0}
            onClick={() => void rotateZidIndexDown(walletId)}
          >
            previous
          </Button>
          <Button
            variant='secondary'
            className='flex-1'
            onClick={() => void rotateZidIndex(walletId)}
          >
            next
          </Button>
        </div>
      </Sheet>

      <Sheet open={open === 'name'} onOpenChange={o => !o && close()} title='name this identity'>
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            void addZidPin(walletId, zidIndex, name).then(close);
          }}
        >
          <Input
            aria-label='name'
            placeholder={label}
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <Button type='submit' disabled={!name.trim()}>
            save
          </Button>
        </form>
      </Sheet>

      <BackupSheet key={`b-${open === 'backup'}`} open={open === 'backup'} onClose={close} />
      <RestoreSheet key={`r-${open === 'restore'}`} open={open === 'restore'} onClose={close} />
    </SettingsScreen>
  );
};

export default IdentityControlsPage;
