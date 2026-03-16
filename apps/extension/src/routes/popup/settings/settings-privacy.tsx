import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';
import { isIbcNetwork, type NetworkType } from '../../../state/keyring/network-types';

interface PrivacyRow {
  key: keyof PrivacySettings;
  label: string;
  onLabel: string;
  offLabel: string;
  /** filter function — return true if this row is visible for the given network */
  visible?: (network: NetworkType) => boolean;
}

const PRIVACY_ROWS: readonly PrivacyRow[] = [
  {
    key: 'enableTransparentBalances',
    label: 'cosmos balances',
    onLabel: 'querying rpc nodes for balances',
    offLabel: 'balances hidden — no rpc queries',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enableTransactionHistory',
    label: 'transaction history',
    onLabel: 'saving history locally',
    offLabel: 'history disabled',
  },
  {
    key: 'enableBackgroundSync',
    label: 'background sync',
    onLabel: 'syncing periodically in background',
    offLabel: 'sync only when extension is open',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enablePriceFetching',
    label: 'price display',
    onLabel: 'fetching prices — apis cannot see your addresses',
    offLabel: 'prices hidden',
    visible: n => n === 'penumbra' || isIbcNetwork(n),
  },
];

function Row({
  label,
  stateLabel,
  checked,
  onChange,
}: {
  label: string;
  stateLabel: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className='flex items-start justify-between gap-4 py-3'>
      <div className='flex-1'>
        <p className='text-sm font-medium'>{label}</p>
        <p className={`text-xs mt-0.5 ${checked ? 'text-green-500' : 'text-muted-foreground'}`}>
          {stateLabel}
        </p>
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
            stateLabel={settings[row.key] ? row.onLabel : row.offLabel}
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
