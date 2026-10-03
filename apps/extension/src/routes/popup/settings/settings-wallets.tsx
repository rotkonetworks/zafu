/**
 * settings > wallets & networks. One row per wallet (its custody and the
 * networks it holds), a sheet for everything about one wallet, then the ways
 * to add one, then the networks. Nothing expands in place: each step is a
 * sheet, so only one secret is ever on screen at a time.
 *
 * Only zcash and penumbra are networks; penumbra's ibc chains live under
 * settings > networks > penumbra. A wallet's networks follow
 * keyInfoSupportsNetwork, so a 12-word vault reads penumbra only.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  keyRingSelector,
  selectEnabledNetworks,
  type KeyInfo,
  type NetworkType,
} from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { walletsSelector, type ZcashWalletJson } from '../../../state/wallets';
import { passwordSelector } from '../../../state/password';
import { Section, SettingsScreen } from './settings-screen';
import { TintedRow } from './tinted-row';
import { openPageInTab } from '../../../utils/popup-detection';
import { PagePath } from '../../page/paths';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { CustodyBadge, custodyOf } from '../../../components/custody-badge';
import { PhraseGrid } from './settings-passphrase';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useExplain } from './settings-explain';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import {
  describeZcashHeight,
  dateToBlock,
  blockToDate,
  formatDateInput,
} from '../../../utils/zcash-blocks';

const NETWORKS = ['zcash', 'penumbra'] as const satisfies readonly NetworkType[];

/** the networks one wallet holds here, among those turned on */
const networksOf = (
  v: KeyInfo,
  held: { penumbra: boolean; zcash: boolean },
  enabled: string[],
): NetworkType[] =>
  NETWORKS.filter(
    n =>
      (enabled.length === 0 || enabled.includes(n)) &&
      keyInfoSupportsNetwork(v, n) &&
      // a seed derives keys for each network it supports; a cold or shared
      // wallet holds only the keys it brought
      (v.type === 'mnemonic' || held[n] || (n === 'zcash' && v.type === 'frost-multisig')),
  );

export const SettingsWallets = ({
  title = 'wallets',
  appendSlot,
}: {
  title?: string;
  /** the networks section, composed into this screen (settings-wallets-networks) */
  appendSlot?: React.ReactNode;
} = {}) => {
  const navigate = usePopupNav();
  const rawNavigate = useNavigate();

  const { keyInfos } = useStore(keyRingSelector);
  const { all: penumbraWallets, zcashWallets } = useStore(walletsSelector);
  const enabledNetworks = useStore(selectEnabledNetworks);

  const [openId, setOpenId] = useState<string | null>(null);

  const zcashOn = enabledNetworks.includes('zcash');
  const hasSeed = keyInfos.some(v => v.type === 'mnemonic');
  const open = keyInfos.find(v => v.id === openId);
  const held = (v: KeyInfo) => ({
    penumbra: penumbraWallets.some(w => w.vaultId === v.id),
    zcash: zcashWallets.some(w => w.vaultId === v.id),
  });

  return (
    <>
      <SettingsScreen title={title} backPath={PopupPath.INDEX}>
        <div className='flex flex-col gap-5'>
          <Section title='wallets'>
            {keyInfos.length === 0 ? (
              <p className='px-3.5 py-6 text-center text-xs text-fg-muted'>no wallets yet</p>
            ) : (
              keyInfos.map(v => (
                <Row
                  key={v.id}
                  type='screen'
                  label={v.name}
                  description={[custodyOf(v.type), ...networksOf(v, held(v), enabledNetworks)].join(
                    ' · ',
                  )}
                  onPress={() => setOpenId(v.id)}
                />
              ))
            )}
          </Section>

          <section className='flex flex-col gap-1.5'>
            <h2 className='text-[11px]/[14px] tracking-[0.06em] text-fg-muted'>add a wallet</h2>
            <RowGroup>
              <Row
                type='screen'
                icon='i-ph-scan'
                label='scan a signer'
                description='zigner, keystone'
                onPress={() => navigate(PopupPath.SETTINGS_CONNECT_DEVICE)}
              />
              {zcashOn && (HARDWARE_WALLET_ENABLED || LEDGER_TRANSPARENT_ENABLED) && (
                <Row
                  type='screen'
                  icon='i-ph-usb'
                  label='connect ledger'
                  description='zcash'
                  // webhid dies with the popup, so the ledger flow runs in a tab
                  onPress={() => void openPageInTab(PagePath.CONNECT_LEDGER, true)}
                />
              )}
              {!hasSeed && (
                <Row
                  type='screen'
                  icon='i-ph-key'
                  label='import a recovery phrase'
                  onPress={() => void chrome.runtime.openOptionsPage()}
                />
              )}
              {zcashOn && (
                <Row
                  type='screen'
                  icon='i-ph-eye'
                  label='add a viewing key'
                  description='watch only'
                  preload={PopupPath.SETTINGS_ADD_VIEWING_KEY}
                  onPress={() => navigate(PopupPath.SETTINGS_ADD_VIEWING_KEY)}
                />
              )}
            </RowGroup>
            <p className='flex items-center justify-between gap-3 px-0.5 text-[11px] text-fg-dim'>
              <span>zafu zigner keeps spending keys offline</span>
              <a
                href='https://zafu.pro/zigner'
                target='_blank'
                rel='noopener noreferrer'
                className='shrink-0 text-zigner-gold hover:underline'
              >
                get it
              </a>
            </p>
          </section>

          {appendSlot}
        </div>
      </SettingsScreen>

      {open && (
        <WalletSheet
          vault={open}
          networks={networksOf(open, held(open), enabledNetworks)}
          multisig={
            open.type === 'frost-multisig'
              ? zcashWallets.find(w => w.vaultId === open.id && w.multisig)
              : undefined
          }
          onClose={() => setOpenId(null)}
          onRemove={() => rawNavigate(`${PopupPath.SETTINGS_REMOVE_WALLET}?id=${open.id}`)}
        />
      )}
    </>
  );
};

type Step = 'main' | 'rename' | 'birthday' | 'password' | 'phrase';

/** everything about one wallet, one step at a time */
const WalletSheet = ({
  vault,
  networks,
  multisig,
  onClose,
  onRemove,
}: {
  vault: KeyInfo;
  networks: NetworkType[];
  multisig?: ZcashWalletJson;
  onClose: () => void;
  onRemove: () => void;
}) => {
  const navigate = usePopupNav();
  const { getMnemonic, renameKeyRing, setMultisigHidden } = useStore(keyRingSelector);
  const { zcashWallets, updateMultisigWallet } = useStore(walletsSelector);
  const { isPassword } = useStore(passwordSelector);
  const [step, setStep] = useState<Step>('main');
  const [draft, setDraft] = useState(vault.name);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hasZcash = networks.includes('zcash');
  const birthday = useBirthday(vault.id, hasZcash);
  const { explainProps, sheet: explainSheet } = useExplain();

  const rename = async () => {
    const name = draft.trim();
    if (name && name !== vault.name) {
      await renameKeyRing(vault.id, name).catch(() => undefined);
      // a multisig's linked wallet carries the same name in the multisig tab
      const ms = zcashWallets.find(w => w.vaultId === vault.id && w.multisig);
      if (ms) {
        await updateMultisigWallet(ms.id, { label: name }).catch(() => undefined);
      }
    }
    setStep('main');
  };

  const reveal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(await isPassword(password))) {
      setWrong(true);
      return;
    }
    try {
      setPhrase((await getMnemonic(vault.id)).split(' '));
      setPassword('');
      setStep('phrase');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg.includes('failed to decrypt vault')
          ? "this wallet's recovery phrase can't be read here. please use the backup you made."
          : msg,
      );
    }
  };

  const titles: Record<Step, string> = {
    main: vault.name,
    rename: 'rename',
    birthday: 'zcash sync start',
    password: 'recovery phrase',
    phrase: 'recovery phrase',
  };

  return (
    <>
    <Sheet
      open
      onOpenChange={o => {
        if (!o) {
          setPhrase([]);
          onClose();
        }
      }}
      title={titles[step]}
    >
      {step === 'main' && (
        <>
          <div className='flex items-center gap-2 text-[11px] text-fg-muted'>
            <CustodyBadge vault={vault} />
            {networks.join(' · ')}
          </div>
          <RowGroup>
            <Row type='screen' label='rename' onPress={() => setStep('rename')} />
            {hasZcash && (
              <Row
                type='value'
                label='zcash sync start'
                value={birthday.valid ? formatDateInput(blockToDate(birthday.height)) : 'auto'}
                onPress={() => setStep('birthday')}
                {...explainProps('network.zcashStartsFrom')}
              />
            )}
            {vault.type === 'zigner-zafu' && hasZcash && (
              <Row
                type='screen'
                label='sync to zigner'
                description='check your notes on zigner'
                preload={PopupPath.NOTE_SYNC}
                onPress={() => navigate(PopupPath.NOTE_SYNC)}
              />
            )}
            {multisig &&
              (multisig.multisig?.hidden ? (
                // an app-managed table is hidden from the multisig tab: offer it back
                <Row
                  type='screen'
                  label='take control of this multisig'
                  onPress={() => void setMultisigHidden(vault.id, false)}
                />
              ) : (
                <Row
                  type='screen'
                  label='manage in multisig'
                  preload={PopupPath.MULTISIG}
                  onPress={() => navigate(PopupPath.MULTISIG)}
                />
              ))}
            {vault.type === 'mnemonic' && (
              <Row type='screen' label='show recovery phrase' onPress={() => setStep('password')} />
            )}
          </RowGroup>
          <RowGroup>
            <TintedRow label='remove wallet' onPress={onRemove} />
          </RowGroup>
        </>
      )}

      {step === 'rename' && (
        <form
          onSubmit={e => {
            e.preventDefault();
            void rename();
          }}
          className='flex flex-col gap-3'
        >
          <Input value={draft} autoFocus onChange={e => setDraft(e.target.value)} />
          <Button type='submit' className='w-full' disabled={!draft.trim()}>
            save
          </Button>
          <Button variant='quiet' className='w-full' onClick={() => setStep('main')}>
            back
          </Button>
        </form>
      )}

      {step === 'birthday' && <BirthdayStep birthday={birthday} onDone={() => setStep('main')} />}

      {step === 'password' && (
        <form onSubmit={e => void reveal(e)} className='flex flex-col gap-3'>
          <p className='text-xs text-fg-muted'>your password, to show this wallet's phrase.</p>
          <Input
            type='password'
            autoFocus
            value={password}
            placeholder='password'
            onChange={e => {
              setPassword(e.target.value);
              setWrong(false);
            }}
          />
          {(wrong || error) && (
            <StatusSlot tone='warn' icon='i-ph-warning'>
              {wrong ? 'that password does not match. please try again.' : error}
            </StatusSlot>
          )}
          <Button type='submit' className='w-full' disabled={!password}>
            show
          </Button>
          <Button variant='quiet' className='w-full' onClick={() => setStep('main')}>
            back
          </Button>
        </form>
      )}

      {step === 'phrase' && (
        <>
          <p className='text-xs text-fg-muted'>
            write it down and keep it offline. anyone with it controls this wallet.
          </p>
          <PhraseGrid words={phrase} revealed onReveal={() => undefined} />
          <Button
            className='w-full'
            onClick={() => {
              setPhrase([]);
              setStep('main');
            }}
          >
            done
          </Button>
        </>
      )}
    </Sheet>
    {explainSheet}
    </>
  );
};

/** a wallet's zcash sync start, held as the height sync reads */
const useBirthday = (vaultId: string, on: boolean) => {
  const key = `zcashBirthday_${vaultId}`;
  const [raw, setRaw] = useState('');
  useEffect(() => {
    if (on) {
      void chrome.storage.local.get(key).then(r => r[key] !== undefined && setRaw(String(r[key])));
    }
  }, [on, key]);
  const height = parseInt(raw, 10);
  return {
    raw,
    setRaw,
    height,
    valid: !isNaN(height) && height >= ZCASH_ORCHARD_ACTIVATION,
    save: (h: number | null) => {
      if (h === null) {
        setRaw('');
        void chrome.storage.local.remove(key);
        return;
      }
      const clamped = Math.max(ZCASH_ORCHARD_ACTIVATION, h);
      setRaw(String(clamped));
      void chrome.storage.local.set({ [key]: clamped });
    },
  };
};

/**
 * asked as a date, the thing a person knows; the block it resolves to sits
 * under it for whoever knows that instead. auto scans recent blocks, so an
 * old wallet left on auto misses its early notes.
 */
const BirthdayStep = ({
  birthday: b,
  onDone,
}: {
  birthday: ReturnType<typeof useBirthday>;
  onDone: () => void;
}) => {
  const hint = b.raw.trim() ? describeZcashHeight(b.height) : null;
  const typed = () => (b.raw === '' ? b.save(null) : !isNaN(b.height) && b.save(b.height));
  return (
    <div className='flex flex-col gap-3'>
      <p className='text-xs text-fg-muted'>
        when this wallet was first used. zcash scans from here.
      </p>
      <Input
        type='date'
        aria-label='first used'
        min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
        max={formatDateInput(new Date())}
        value={b.valid ? formatDateInput(blockToDate(b.height)) : ''}
        onChange={e =>
          b.save(e.target.value ? dateToBlock(new Date(`${e.target.value}T00:00:00Z`)) : null)
        }
      />
      <Input
        type='number'
        aria-label='block'
        min={ZCASH_ORCHARD_ACTIVATION}
        step='1000'
        placeholder='or a block · auto'
        value={b.raw}
        onChange={e => b.setRaw(e.target.value)}
        onBlur={typed}
        className='font-mono'
      />
      <span className={hint && !hint.ok ? 'text-label text-hanko' : 'text-label text-fg-dim'}>
        {hint ? hint.text : 'auto · scans recent blocks, set a date if older'}
      </span>
      <Button
        className='w-full'
        onClick={() => {
          typed();
          onDone();
        }}
      >
        done
      </Button>
      {b.raw && (
        <Button variant='quiet' className='w-full' onClick={() => b.save(null)}>
          back to auto
        </Button>
      )}
    </div>
  );
};
