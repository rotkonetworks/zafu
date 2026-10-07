/**
 * backups (Backups.dc.html): the recovery phrase per hot wallet, then every
 * group seat with where its share lives and whether it was ever exported.
 * a group seat is not in the recovery phrase, so each one is backed up on
 * its own; an airgap seat lives on zigner and is backed up there.
 */

import { useState, type ReactNode } from 'react';
import { useStore } from '../../../state';
import { selectKeyInfos } from '../../../state/keyring';
import { selectMultisigWallets, type ZcashWalletJson } from '../../../state/wallets';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { cn } from '@repo/ui/lib/utils';
import { Section, SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { usePopupNav } from '../../../utils/navigate';
import { usePasswordGate } from '../../../hooks/password-gate';
import { BackupModal } from '../multisig/backup/backup-modal';
import { ImportModal } from '../multisig/backup/import-modal';
import { AirgapQrImportModal } from '../multisig/backup/airgap-qr-import-modal';
import { exportSingleBackup } from '../multisig/backup/export-helpers';
import { Clipped } from '@repo/ui/components/ui/clipped';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase();

/** what a seat row says about its backup, as data */
const seatState = (w: ZcashWalletJson) =>
  w.multisig?.room && !w.multisig.backedUpAt
    ? {
        mark: 'size-3.5 border border-warn',
        meta: `${w.multisig.room.roomId.startsWith('p:') ? 'a deal' : 'a group'} · never backed up`,
        warn: true,
      }
    : w.multisig?.custody === 'airgapSigner'
      ? {
          mark: 'i-ph-asterisk size-4 text-zafu-blue',
          meta: 'seat lives on zigner · back up there',
        }
      : w.multisig?.backedUpAt
        ? { mark: 'size-3.5 bg-success', meta: `encrypted file · ${fmtDay(w.multisig.backedUpAt)}` }
        : { mark: 'size-3.5 border border-warn', meta: 'never backed up', warn: true };

const Line = ({
  mark,
  name,
  meta,
  warn,
  children,
}: {
  mark: string;
  name: string;
  meta: string;
  warn?: boolean;
  children?: ReactNode;
}) => (
  <div className='flex min-h-[58px] items-center gap-3 px-3.5 py-2'>
    <span className={cn('grid w-4 shrink-0 place-items-center', mark)} aria-hidden='true' />
    <span className='flex min-w-0 grow flex-col gap-[3px]'>
      <Clipped className='text-sm text-fg-high lowercase'>{name}</Clipped>
      <Clipped className={cn('text-[11px]', warn ? 'text-warn' : 'text-fg-muted')}>{meta}</Clipped>
    </span>
    {children}
  </div>
);

export const SettingsMultisigBackup = () => {
  const navigate = usePopupNav();
  const hot = useStore(selectKeyInfos).filter(k => k.type === 'mnemonic');
  const all = useStore(selectMultisigWallets);
  const seats = all.filter(w => !w.multisig?.hidden);
  const tables = all.length - seats.length;

  const [target, setTarget] = useState<ZcashWalletJson | null>(null);
  const [restore, setRestore] = useState<'pick' | 'file' | 'qr' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { requestAuth, PasswordModal } = usePasswordGate();

  const restored = (s: { imported: number; skipped: number }) =>
    setNote(
      `restored ${plural(s.imported, 'seat')}` + (s.skipped ? ` · ${s.skipped} already here` : ''),
    );
  const openRestore = async (how: 'file' | 'qr') => {
    setRestore(null);
    if (await requestAuth()) {
      setRestore(how);
    }
  };

  return (
    <SettingsScreen title='backups' meta='security' backPath={PopupPath.SETTINGS_SECURITY}>
      {PasswordModal}
      <BackupModal
        open={target !== null}
        title={target ? `back up ${target.label}` : ''}
        walletLabel={target?.label ?? ''}
        onConfirm={async passphrase => {
          if (target) {
            await exportSingleBackup(target, passphrase);
          }
        }}
        onClose={() => setTarget(null)}
      />
      <ImportModal
        open={restore === 'file'}
        onClose={() => setRestore(null)}
        onImported={restored}
      />
      <AirgapQrImportModal
        open={restore === 'qr'}
        onClose={() => setRestore(null)}
        onImported={restored}
      />

      <div className='flex grow flex-col gap-4'>
        {hot.length > 0 && (
          <Section title='recovery phrase'>
            {hot.map(k => (
              <button
                key={k.id}
                type='button'
                data-preload={PopupPath.SETTINGS_RECOVERY_PASSPHRASE}
                onClick={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
                className='text-left transition-colors hover:bg-surface-elev-2'
              >
                <Line
                  mark='size-3.5 border border-fg-dim'
                  name={k.name}
                  meta='restores every pocket'
                />
              </button>
            ))}
          </Section>
        )}

        {seats.length > 0 && (
          <Section title='group seats' aside='not in your recovery phrase'>
            {seats.map(w => {
              const s = seatState(w);
              // frost share export stays reachable even once a seat is backed
              // up - only an airgap seat (exported on zigner itself) has none
              return (
                <Line key={w.id} mark={s.mark} name={w.label} meta={s.meta} warn={s.warn}>
                  {w.multisig?.custody !== 'airgapSigner' && (
                    <Button
                      variant={s.warn ? 'primary' : 'secondary'}
                      size='sm'
                      className='h-8'
                      onClick={async () => {
                        if (await requestAuth()) {
                          setTarget(w);
                        }
                      }}
                    >
                      {s.warn ? 'back up' : 'export'}
                    </Button>
                  )}
                </Line>
              );
            })}
          </Section>
        )}
        {tables > 0 && (
          <p className='-mt-2.5 text-[11px] text-fg-dim'>
            poker tables close when settled · no backup needed
          </p>
        )}
      </div>

      <div className='-mx-4 mt-4 flex flex-col gap-2 border-t border-border-soft px-4 pt-4'>
        {note && <StatusSlot>{note}</StatusSlot>}
        <Button variant='secondary' size='md' className='w-full' onClick={() => setRestore('pick')}>
          restore from a backup
        </Button>
      </div>

      <Sheet
        open={restore === 'pick'}
        onOpenChange={o => setRestore(o ? 'pick' : null)}
        title='restore from a backup'
      >
        <RowGroup>
          <Row type='screen' label='from a backup file' onPress={() => void openRestore('file')} />
          <Row type='screen' label='from zigner qr' onPress={() => void openRestore('qr')} />
        </RowGroup>
      </Sheet>
    </SettingsScreen>
  );
};
