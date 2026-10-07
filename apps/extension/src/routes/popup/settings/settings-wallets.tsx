/**
 * settings > wallets and devices > wallets. One row per wallet (its custody
 * and the networks it holds), a sheet for everything about one wallet, then
 * the ways to add one. Its phrase, start height and removal each have one
 * home (security, zcash), and the sheet links there.
 *
 * A wallet's networks follow keyInfoSupportsNetwork, so a 12-word vault reads
 * penumbra only.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  keyRingSelector,
  selectEffectiveKeyInfo,
  selectEnabledNetworks,
  type KeyInfo,
  type NetworkType,
} from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { walletsSelector, type ZcashWalletJson } from '../../../state/wallets';
import { Section, SettingsScreen } from './settings-screen';
import { openPageInTab } from '../../../utils/popup-detection';
import { PagePath } from '../../page/paths';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { CustodyBadge, custodyOf } from '../../../components/custody-badge';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';

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

export const SettingsWallets = () => {
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
      <SettingsScreen title='wallets' backPath={PopupPath.SETTINGS_DEVICES}>
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

type Step = 'main' | 'rename';

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
  const { renameKeyRing, setMultisigHidden } = useStore(keyRingSelector);
  const { zcashWallets, updateMultisigWallet } = useStore(walletsSelector);
  const inView = useStore(selectEffectiveKeyInfo)?.id === vault.id;
  const [step, setStep] = useState<Step>('main');
  const [draft, setDraft] = useState(vault.name);
  const hasZcash = networks.includes('zcash');

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

  return (
    <Sheet open onOpenChange={o => !o && onClose()} title={step === 'main' ? vault.name : 'rename'}>
      {step === 'main' && (
        <>
          <div className='flex items-center gap-2 text-[11px] text-fg-muted'>
            <CustodyBadge vault={vault} />
            {networks.join(' · ')}
          </div>
          <RowGroup>
            <Row type='screen' label='rename' onPress={() => setStep('rename')} />
            {/* the start height lives on the zcash screen, for the wallet in view */}
            {hasZcash && inView && (
              <Row
                type='screen'
                label='zcash sync start'
                preload={PopupPath.SETTINGS_ZCASH_NETWORK}
                onPress={() => navigate(PopupPath.SETTINGS_ZCASH_NETWORK)}
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
              <Row
                type='screen'
                label='show recovery phrase'
                preload={PopupPath.SETTINGS_RECOVERY_PASSPHRASE}
                onPress={() =>
                  navigate(`${PopupPath.SETTINGS_RECOVERY_PASSPHRASE}?id=${vault.id}` as PopupPath)
                }
              />
            )}
          </RowGroup>
          <RowGroup>
            <Row type='screen' danger label='remove wallet' onPress={onRemove} />
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
    </Sheet>
  );
};
