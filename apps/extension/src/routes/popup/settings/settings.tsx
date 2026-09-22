import { Fragment } from 'react';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectActiveNetwork } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SUBSCRIBE_ENABLED } from '../../../config/feature-flags';
import { SettingsScreen } from './settings-screen';
import { cn } from '@repo/ui/lib/utils';

interface SettingsLink {
  title: string;
  icon: string;
  href: PopupPath;
  /** which networks show this link. undefined = always visible */
  networks?: string[];
}

interface SettingsGroup {
  /** lowercase kicker header for the group */
  label: string;
  links: SettingsLink[];
  /** when set, this group holds one network's own settings - render a
      network-coloured dot on the kicker so the separation is unmistakable. */
  network?: string;
}

// dot colours mirror the wallet-panel network tags so a network reads the same
// everywhere in the app.
const NETWORK_DOT: Record<string, string> = {
  zcash: 'bg-yellow-400',
  penumbra: 'bg-teal-300',
};

// Grouped by intent: what protects funds first (security & backup, with
// auto-lock rendered inline in that group), then privacy, then wallet
// plumbing (networks, zigner), then about. Lock stays pinned at the
// bottom where muscle memory can't hit it by accident.
//
// TODO(orphan): link or delete - settings-rpc, settings-numeraires,
// settings-trading-mode, and settings-parachains have screens but no route
// and no nav-in. Decide whether they should be reachable or removed.
const groups: SettingsGroup[] = [
  {
    label: 'security & backup',
    links: [
      // Single hub. It holds auto-lock and links to the canonical recovery-
      // passphrase / multisig-backup / clear-cache screens - so those are no
      // longer duplicated as flat rows here (they were reachable both ways).
      {
        title: 'security & backup',
        icon: 'i-ph-shield-check',
        href: PopupPath.SETTINGS_SECURITY_BACKUP,
      },
    ],
  },
  {
    label: 'privacy',
    links: [
      {
        title: 'privacy',
        icon: 'i-ph-eye-slash',
        href: PopupPath.SETTINGS_PRIVACY,
      },
      {
        title: 'connected sites',
        icon: 'i-ph-globe',
        href: PopupPath.SETTINGS_CONNECTED_SITES,
      },
    ],
  },
  {
    label: 'wallet',
    links: [
      {
        // wallets + networks are one screen now - manage vaults and enable/
        // disable networks in the same place.
        title: 'wallets & networks',
        icon: 'i-ph-wallet',
        href: PopupPath.SETTINGS_WALLETS,
      },
      {
        title: 'appearance',
        icon: 'i-zafu-enso',
        href: PopupPath.SETTINGS_APPEARANCE,
      },
      {
        title: 'fees',
        icon: 'i-zafu-mon',
        href: PopupPath.SETTINGS_FEES,
        networks: ['zcash'],
      },
      {
        title: 'voting endpoints',
        icon: 'i-ph-check-square-offset',
        href: PopupPath.SETTINGS_VOTING,
        networks: ['zcash'],
      },
      {
        title: 'zcash.me directory',
        icon: 'i-ph-address-book',
        href: PopupPath.SETTINGS_ZCASHME,
        networks: ['zcash'],
      },
      {
        title: 'zigner',
        icon: 'i-ph-qr-code',
        href: PopupPath.SETTINGS_ZIGNER,
      },
      {
        title: 'device update',
        icon: 'i-ph-cpu',
        href: PopupPath.SETTINGS_OTA,
      },
    ],
  },
  {
    label: 'about',
    links: [
      ...(SUBSCRIBE_ENABLED
        ? [
            {
              title: 'pro subscription',
              icon: 'i-ph-lightning',
              href: PopupPath.SUBSCRIBE,
            },
          ]
        : []),
      {
        title: 'about',
        icon: 'i-ph-info',
        href: PopupPath.SETTINGS_ABOUT,
      },
    ],
  },
];

function SettingsRow({
  icon,
  title,
  onClick,
}: {
  icon: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className='flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elev-1 hover:text-fg-high group'
    >
      <span className={cn(icon, 'size-5 text-fg-muted group-hover:text-fg-high')} />
      <span className='flex-1 text-data text-fg group-hover:text-fg-high lowercase'>{title}</span>
      <span className='i-ph-caret-right size-4 text-fg-dim group-hover:text-fg-muted' />
    </button>
  );
}

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);
  const activeNetwork = useStore(selectActiveNetwork);

  // Generic settings keep their intent groups; anything network-specific is
  // pulled OUT of them and shown under its own group, headed by the network it
  // belongs to (with a network-coloured dot). This makes "these are zcash's
  // settings" explicit, instead of zcash rows silently appearing inside
  // security & backup / wallet and vanishing when you switch to penumbra.
  const genericGroups = groups
    .map(g => ({ ...g, links: g.links.filter(l => !l.networks) }))
    .filter(g => g.links.length > 0);

  const networkLinks = groups
    .flatMap(g => g.links)
    .filter(l => l.networks?.includes(activeNetwork));

  const networkGroup: SettingsGroup | null =
    networkLinks.length > 0
      ? { label: `${activeNetwork} settings`, links: networkLinks, network: activeNetwork }
      : null;

  // order: security & backup, privacy, <active network>, wallet, about - the
  // network section sits right above the generic wallet plumbing.
  const visibleGroups: SettingsGroup[] = [];
  for (const g of genericGroups) {
    if (g.label === 'wallet' && networkGroup) {
      visibleGroups.push(networkGroup);
    }
    visibleGroups.push(g);
  }
  if (networkGroup && !visibleGroups.includes(networkGroup)) {
    visibleGroups.push(networkGroup);
  }

  return (
    <SettingsScreen title='settings' backPath={PopupPath.INDEX}>
      <div className='flex grow flex-col justify-between'>
        <div className='flex flex-col gap-4'>
          {visibleGroups.map(group => (
            <div key={group.label}>
              <p className='kicker px-4 pb-1 flex items-center gap-1.5'>
                {group.network && (
                  <span
                    className={cn(
                      'inline-block size-2 rounded-full',
                      NETWORK_DOT[group.network] ?? 'bg-fg-dim',
                    )}
                  />
                )}
                {group.label}
              </p>
              <div className='flex flex-col divide-y divide-border-soft/40'>
                {group.links.map(l => (
                  <Fragment key={l.href}>
                    {/* auto-lock now lives in the Security & Backup screen (its own
                        select control), not as an inline row here - see
                        settings-security-backup.tsx. */}
                    <SettingsRow icon={l.icon} title={l.title} onClick={() => navigate(l.href)} />
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className='mt-4 border-t border-border-soft pt-4'>
          <SettingsRow
            icon='i-ph-sign-out'
            title='lock wallet'
            onClick={() => {
              clearSessionPassword();
              chrome.runtime.reload();
            }}
          />
        </div>
      </div>
    </SettingsScreen>
  );
};
