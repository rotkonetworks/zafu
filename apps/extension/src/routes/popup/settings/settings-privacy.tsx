import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';

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

  return (
    <SettingsScreen title='Privacy'>
      <div className='flex flex-col divide-y divide-border/30'>
        <Row
          label='cosmos balance queries'
          note='leaks addresses to rpc nodes'
          checked={settings.enableTransparentBalances}
          onChange={v => setSetting('enableTransparentBalances', v)}
        />
        <Row
          label='transaction history'
          note='stored locally'
          checked={settings.enableTransactionHistory}
          onChange={v => setSetting('enableTransactionHistory', v)}
        />
        <Row
          label='cosmos background sync'
          note='periodic rpc queries. shielded networks sync automatically.'
          checked={settings.enableBackgroundSync}
          onChange={v => setSetting('enableBackgroundSync', v)}
        />
        <Row
          label='price fetching'
          note='price apis do not learn your addresses'
          checked={settings.enablePriceFetching}
          onChange={v => setSetting('enablePriceFetching', v)}
        />
      </div>
    </SettingsScreen>
  );
}
