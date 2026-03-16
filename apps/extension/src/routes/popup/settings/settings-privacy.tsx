import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';
import { isIbcNetwork, type NetworkType } from '../../../state/keyring/network-types';

interface PrivacyRow {
  key: keyof PrivacySettings;
  label: string;
  note: string;
  /** filter function — return true if this row is visible for the given network */
  visible?: (network: NetworkType) => boolean;
}

const PRIVACY_ROWS: readonly PrivacyRow[] = [
  {
    key: 'enableTransparentBalances',
    label: 'cosmos balance queries',
    note: 'leaks addresses to rpc nodes',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enableTransactionHistory',
    label: 'transaction history',
    note: 'stored locally',
  },
  {
    key: 'enableBackgroundSync',
    label: 'cosmos background sync',
    note: 'periodic rpc queries. shielded networks sync automatically.',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enablePriceFetching',
    label: 'price fetching',
    note: 'price apis do not learn your addresses',
    visible: n => n === 'penumbra' || isIbcNetwork(n),
  },
];

function Row({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className='flex items-start justify-between gap-4 py-3'>
      <div className='flex-1'>
        <p className='text-sm font-medium'>{label}</p>
        <p className='text-xs text-muted-foreground mt-0.5'>{note}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function SettingsPrivacy() {
  const { settings, setSetting } = useStore(privacySelector);
  const activeNetwork = useStore(selectActiveNetwork);

  const visibleRows = PRIVACY_ROWS.filter(
    row => !row.visible || row.visible(activeNetwork),
  );

  return (
    <SettingsScreen title='privacy'>
      <div className='flex flex-col divide-y divide-border/40'>
        {visibleRows.map(row => (
          <Row
            key={row.key}
            label={row.label}
            note={row.note}
            checked={settings[row.key]}
            onChange={v => setSetting(row.key, v)}
          />
        ))}
        {visibleRows.length === 0 && (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            no privacy settings for this network
          </p>
        )}
      </div>
    </SettingsScreen>
  );
}
