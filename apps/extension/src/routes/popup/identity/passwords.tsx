/**
 * passkeys and passwords (IdKeys.dc.html): the sites that hold a zafu passkey
 * (each one comes back from the recovery phrase), then the deterministic
 * password generator - derive passwords from seed + site +
 * username. the password is never stored. same seed, site, username, length
 * and rotation always derive the same password (see state/identity.ts:
 * derivePassword). a saved login keeps only what fills the form again, sealed
 * (state/password-logins.ts), and goes into the personal-data backup.
 *
 * only a mnemonic wallet can derive - a zigner, viewing-key, ledger or
 * multisig wallet has no phrase on this device, so the form stays disabled
 * with one calm line instead of failing silently.
 *
 * TODO(seed exposure): getMnemonic decrypts the phrase here, in the popup.
 * state/shared/vault-seal.ts + getVaultUnlock already move a decrypt like
 * this into the zcash worker for sends, so it never touches the popup - but
 * that worker only exists when zcash is enabled, and passwords is an
 * everywhere tool (a penumbra-only wallet has no zcash worker to host it
 * in). Moving this derivation there would make an everywhere tool secretly
 * depend on a zcash-only process. Needs its own always-on host (or a
 * network-agnostic seal target) before this can move out of the popup.
 */

import { useEffect, useState } from 'react';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Input } from '@repo/ui/components/ui/input';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { getAllPermissions } from '@repo/storage-chrome/origin';
import { useStore } from '../../../state';
import { selectSelectedKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import {
  derivePassword,
  normalizeOriginFor,
  DEFAULT_IDENTITY,
  PASSWORD_SCHEME,
} from '../../../state/identity';
import { pocketOwner } from '../../../state/pockets';
import {
  forgetPasswordLogin,
  readPasswordLogins,
  savePasswordLogin,
  schemeOf,
  type PasswordLogin,
} from '../../../state/password-logins';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { hostOf, shortDay } from './site-list';

/** sites holding a zafu passkey, newest first */
const usePasskeys = () => {
  const [sites, setSites] = useState<{ origin: string; at: number }[]>([]);
  useEffect(() => {
    void getAllPermissions().then(all =>
      setSites(
        all
          .filter(p => p.granted.includes('passkey'))
          .map(p => ({ origin: p.origin, at: p.grantedAt }))
          .sort((a, b) => b.at - a.at),
      ),
    );
  }, []);
  return sites;
};

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
  // a password made before saved logins recorded their scheme, never saved:
  // the person can still ask for the older derivation
  const [older, setOlder] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const owner = keyInfo ? pocketOwner(keyInfo) : undefined;
  const [logins, setLogins] = useState<PasswordLogin[]>([]);
  const [picking, setPicking] = useState(false);
  const passkeys = usePasskeys();

  useEffect(() => {
    void readPasswordLogins().then(setLogins, () => setLogins([]));
  }, []);

  const mine = logins.filter(l => l.owner === owner);
  // a saved login keeps the scheme it was made with, so its password never
  // changes; anything new is made with the current one
  const saved = mine.find(
    l => l.site === normalizeOriginFor(schemeOf(l), site) && l.username === username.trim(),
  );
  const scheme = saved ? schemeOf(saved) : older ? 1 : PASSWORD_SCHEME;
  const here = {
    owner: owner ?? '',
    site: normalizeOriginFor(scheme, site),
    username: username.trim(),
  };
  const unchanged = saved?.length === length && saved.version === rotation;
  const fill = (l: PasswordLogin) => {
    setSite(l.site);
    setUsername(l.username);
    setLength(LENGTHS.find(n => n === l.length) ?? 32);
    setRotation(l.version);
    setRevealed(false);
  };
  const keep = (next: Promise<PasswordLogin[]>) =>
    void next.then(setLogins, () =>
      setError('zafu could not reach your saved logins. please unlock and try again.'),
    );

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
            scheme,
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
  }, [canDerive, keyInfo, site, username, length, rotation, scheme, getMnemonic]);

  return (
    <SettingsScreen title='passkeys and passwords' backPath={PopupPath.IDENTITY}>
      <div className='flex flex-col gap-4'>
        <section className='flex flex-col gap-1.5'>
          <h2 className='text-[11px] tracking-[0.06em] text-fg-muted'>passkeys</h2>
          {passkeys.length > 0 && (
            <RowGroup>
              {passkeys.map(p => (
                <div key={p.origin} className='flex h-[50px] items-center gap-3 px-3.5'>
                  <span className='grow truncate text-sm text-fg-high'>{hostOf(p.origin)}</span>
                  <span className='text-[11px] text-fg-muted'>{shortDay(p.at)}</span>
                </div>
              ))}
            </RowGroup>
          )}
          <span className='text-[11px] text-fg-dim'>
            {passkeys.length
              ? 'restored from your recovery phrase · nothing to back up'
              : 'no passkeys yet · a site asks when it wants one'}
          </span>
        </section>
        <h2 className='-mb-2 text-[11px] tracking-[0.06em] text-fg-muted'>make a password</h2>
        {!canDerive && (
          <StatusSlot tone='info' icon='i-ph-info'>
            <span>
              {keyInfo
                ? "this wallet has no recovery phrase on this device, so it doesn't make passwords."
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
          {site.trim() && here.site !== site.trim().toLowerCase() && (
            <span className='text-label text-fg-dim'>-&gt; {here.site}</span>
          )}

          <div className='flex h-[52px] items-center gap-2.5 border border-border-hard bg-elev-1 px-3'>
            <span className='flex-1 truncate font-mono text-sm text-zigner-gold tracking-wide'>
              {password ? (revealed ? password : '•'.repeat(Math.min(length, 24))) : '- -'}
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

          <div className='flex items-center justify-between text-[11px] text-fg-muted'>
            <button
              type='button'
              disabled={!canDerive}
              onClick={() => setPicking(true)}
              className='hover:text-fg-high'
            >
              {length} characters · version {rotation + 1}
              {deriving ? ' · deriving...' : ''}
            </button>
            <span className='flex items-center gap-3'>
              {!saved && (
                <button
                  type='button'
                  disabled={!canDerive}
                  aria-pressed={older}
                  onClick={() => setOlder(o => !o)}
                  className='hover:text-fg-high'
                >
                  {older ? 'as an older zafu made it' : 'made by an older zafu?'}
                </button>
              )}
              {rotation > 0 && (
                <button
                  type='button'
                  onClick={() => setRotation(r => Math.max(0, r - 1))}
                  className='hover:text-fg-high'
                >
                  previous
                </button>
              )}
              <button
                type='button'
                disabled={!canDerive}
                onClick={() => setRotation(r => r + 1)}
                className='text-zigner-gold hover:underline'
              >
                new version
              </button>
            </span>
          </div>

          <div className='min-h-[1.25rem]'>
            {error && (
              <StatusSlot tone='danger' icon='i-ph-warning'>
                {error}
              </StatusSlot>
            )}
          </div>

          {owner && site.trim() && (
            <Button
              variant='secondary'
              disabled={!canDerive || unchanged}
              onClick={() =>
                keep(
                  savePasswordLogin({
                    ...here,
                    length,
                    version: rotation,
                    scheme,
                    savedAt: Date.now(),
                  }),
                )
              }
            >
              {saved ? (unchanged ? 'saved' : 'save this version') : 'save login'}
            </Button>
          )}

          <span className='text-label text-fg-dim'>
            made from your recovery phrase · the same inputs always give the same password · the
            password itself is never stored
          </span>
        </div>

        {mine.length > 0 && (
          <RowGroup>
            {mine.map(l => (
              <Row
                key={`${l.site}\n${l.username}`}
                type='value'
                label={l.username ? `${l.site} · ${l.username}` : l.site}
                value={`${l.length} · version ${l.version + 1}`}
                onPress={() => fill(l)}
              />
            ))}
          </RowGroup>
        )}
        {saved && (
          <Button variant='quiet' onClick={() => keep(forgetPasswordLogin(here))}>
            forget {saved.site}
          </Button>
        )}
      </div>
      <Sheet open={picking} onOpenChange={setPicking} title='length'>
        <RowGroup>
          {LENGTHS.map(l => (
            <Row
              key={l}
              type='value'
              label={`${l} characters`}
              value={l === length ? 'now' : undefined}
              onPress={() => {
                setLength(l);
                setPicking(false);
              }}
            />
          ))}
        </RowGroup>
      </Sheet>
    </SettingsScreen>
  );
};
