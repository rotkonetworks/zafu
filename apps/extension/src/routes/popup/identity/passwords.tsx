/**
 * deterministic password generator - derive passwords from seed + site +
 * username. nothing stored. same seed, site, username, length and rotation
 * always derive the same password (see state/identity.ts: derivePassword).
 *
 * only a mnemonic wallet can derive - a zigner, viewing-key, ledger or
 * multisig wallet has no phrase on this device, so the form stays disabled
 * with one calm line instead of failing silently.
 */

import { useEffect, useState } from 'react';
import { Input } from '@repo/ui/components/ui/input';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useStore } from '../../../state';
import { selectSelectedKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { derivePassword, normalizeOrigin, DEFAULT_IDENTITY } from '../../../state/identity';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

// the seed feeding the encoder is 32 bytes, 8 groups of at most 5 base85
// characters each - 40 is the real ceiling (see derive-password.test.ts).
const LENGTHS = [16, 24, 32, 40] as const;

export const PasswordsPage = () => {
  const keyInfo = useStore(selectSelectedKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const canDerive = keyInfo?.type === 'mnemonic';

  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [length, setLength] = useState<(typeof LENGTHS)[number]>(32);
  const [rotation, setRotation] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);

  useEffect(() => {
    setPassword(null);
    setError(null);
    if (!canDerive || !keyInfo || !site.trim()) {
      return;
    }
    let cancelled = false;
    setDeriving(true);
    void (async () => {
      try {
        const mnemonic = await getMnemonic(keyInfo.id);
        if (cancelled) {
          return;
        }
        setPassword(
          derivePassword(
            mnemonic,
            DEFAULT_IDENTITY,
            site.trim(),
            username.trim(),
            length,
            rotation,
          ),
        );
      } catch {
        if (!cancelled) {
          setError('something broke on our side, not yours. nothing was lost.');
        }
      } finally {
        if (!cancelled) {
          setDeriving(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canDerive, keyInfo, site, username, length, rotation, getMnemonic]);

  return (
    <SettingsScreen title='passwords' backPath={PopupPath.TOOLS}>
      <div className='flex flex-col gap-4'>
        {!canDerive && (
          <StatusSlot tone='info' icon='i-ph-info'>
            <span>
              {keyInfo
                ? 'this wallet has no recovery phrase on this device, so it cannot make passwords.'
                : 'no wallet to derive from yet.'}
            </span>
          </StatusSlot>
        )}

        <div className='flex flex-col gap-3'>
          <div className='flex gap-2'>
            <Input
              aria-label='site'
              placeholder='site (e.g. github.com)'
              value={site}
              onChange={e => setSite(e.target.value)}
              disabled={!canDerive}
              className='flex-1'
            />
            <Input
              aria-label='username'
              placeholder='username'
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={!canDerive}
              className='w-28'
            />
          </div>
          {site.trim() && normalizeOrigin(site) !== site.trim().toLowerCase() && (
            <span className='text-label text-fg-dim'>-&gt; {normalizeOrigin(site)}</span>
          )}

          <Segmented
            label='password length'
            value={String(length)}
            onChange={v => setLength(Number(v) as (typeof LENGTHS)[number])}
            options={LENGTHS.map(l => ({
              value: String(l),
              label: String(l),
              disabled: !canDerive,
            }))}
          />

          <div className='flex h-[52px] items-center gap-2.5 border border-border-hard bg-elev-1 px-3'>
            <span className='flex-1 truncate font-mono text-sm text-zigner-gold tracking-wide'>
              {password ? (revealed ? password : '•'.repeat(Math.min(length, 24))) : '—'}
            </span>
            <Button
              variant='secondary'
              size='sm'
              disabled={!password}
              onClick={() => setRevealed(r => !r)}
            >
              {revealed ? 'hide' : 'show'}
            </Button>
            <CopyButton
              text={password ?? ''}
              variant='primary'
              size='sm'
              label='copy'
              disabled={!password}
            />
          </div>

          <div className='flex items-center justify-between text-label text-fg-muted'>
            <span>
              {rotation === 0 ? 'original version' : `version ${rotation}`}
              {deriving ? ' · deriving...' : ''}
            </span>
            <div className='flex items-center gap-1.5'>
              <Button
                variant='quiet'
                size='sm'
                disabled={!canDerive || rotation === 0}
                onClick={() => setRotation(r => Math.max(0, r - 1))}
                aria-label='previous version'
              >
                <span className='i-ph-minus size-3.5' />
              </Button>
              <Button
                variant='quiet'
                size='sm'
                disabled={!canDerive}
                onClick={() => setRotation(r => r + 1)}
                aria-label='new version'
              >
                <span className='i-ph-plus size-3.5' />
                new version
              </Button>
            </div>
          </div>

          <div className='min-h-[1.25rem]'>
            {error && (
              <StatusSlot tone='danger' icon='i-ph-warning'>
                {error}
              </StatusSlot>
            )}
          </div>

          <span className='text-label text-fg-dim'>
            made from your recovery phrase · the same inputs always give the same password · nothing
            is stored
          </span>
        </div>
      </div>
    </SettingsScreen>
  );
};
