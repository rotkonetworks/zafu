import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from './settings-screen';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';

/**
 * "Security & Backup" hub. Auto-lock is the one control that has no dedicated
 * screen, so it lives here inline. Everything else (recovery phrase, multisig
 * backup, clear cache) already has its own canonical screen - so this hub LINKS
 * to those rather than reimplementing them (an earlier version duplicated the
 * recovery-phrase reveal and a weaker clear-cache; those are gone). One place to
 * find all security actions, no duplicate implementations.
 */
export const SecurityBackup = () => {
  const navigate = usePopupNav();
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  const zcashOn = enabledNetworks.length === 0 || enabledNetworks.includes('zcash');

  return (
    <SettingsScreen title='security & backup'>
      <div className='flex flex-col gap-5'>
        <AutoLock />

        <div>
          <p className='kicker mb-2'>backup & recovery</p>
          <div className='flex flex-col divide-y divide-border-soft/40 rounded-lg border border-border-soft bg-elev-1'>
            <LinkRow
              icon='i-ph-file-text'
              title='recovery passphrase'
              hint='reveal this wallet&#39;s seed phrase'
              onClick={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
            />
            {zcashOn && (
              <LinkRow
                icon='i-ph-shield'
                title='multisig backup'
                hint='back up FROST multisig shares'
                onClick={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
              />
            )}
            <LinkRow
              icon='i-ph-trash'
              title='clear cache'
              hint='recover from a stuck sync - keys & history kept'
              onClick={() => navigate(PopupPath.SETTINGS_CLEAR_CACHE)}
            />
          </div>
        </div>
      </div>
    </SettingsScreen>
  );
};

/* ── auto-lock (the one control with no dedicated screen) ─────────────── */

const AutoLock = () => {
  const { minutes, set } = useAutoLock();

  return (
    <div>
      <p className='kicker mb-2'>auto-lock</p>
      <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-label text-fg-muted'>
          lock the wallet after this long with no activity.
        </p>
        <div className='flex flex-wrap gap-1.5'>
          {AUTO_LOCK_OPTIONS.map(o => (
            <button
              key={o.value}
              onClick={() => set(o.value)}
              className={cn(
                'rounded border px-2 py-0.5 text-label transition-colors',
                minutes === o.value
                  ? 'border-zigner-gold/50 bg-zigner-gold/10 text-zigner-gold'
                  : 'border-border-soft text-fg-muted hover:text-fg-high hover:border-fg-muted',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ── link row to a canonical screen ──────────────────────────────────── */

const LinkRow = ({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className='group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-elev-2'
  >
    <span className={cn(icon, 'size-5 text-fg-muted group-hover:text-fg-high')} />
    <span className='flex flex-1 flex-col'>
      <span className='text-data text-fg group-hover:text-fg-high lowercase'>{title}</span>
      <span className='text-label text-fg-dim'>{hint}</span>
    </span>
    <span className='i-ph-caret-right size-4 text-fg-dim group-hover:text-fg-muted' />
  </button>
);
