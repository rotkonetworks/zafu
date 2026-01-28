/**
 * privacy settings screen
 *
 * controls opt-in features that may leak metadata.
 * three privacy tiers:
 * 1. shielded (penumbra, zcash) - trial decryption, always safe
 * 2. light client (polkadot) - p2p, no central rpc
 * 3. transparent (cosmos) - centralized rpc, opt-in only
 */

import { useStore } from '../../../state';
import { privacySelector, SHIELDED_NETWORKS, LIGHT_CLIENT_NETWORKS, TRANSPARENT_NETWORKS } from '../../../state/privacy';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';
import { EyeClosedIcon } from '@radix-ui/react-icons';

interface SettingRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  warning?: boolean;
}

function SettingRow({ label, description, checked, onChange, warning }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
        {warning && checked && (
          <p className="text-xs text-yellow-500 mt-1">
            ⚠ leaks address activity to rpc nodes
          </p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function SettingsPrivacy() {
  const { settings, setSetting, hasLeakyFeatures } = useStore(privacySelector);

  return (
    <SettingsScreen
      title="privacy"
      IconComponent={() => <EyeClosedIcon className="size-5" />}
    >
      <div className="flex flex-col gap-4">
        {/* info box */}
        <div className="rounded-lg border border-border bg-card-radial p-4">
          <p className="text-sm text-muted-foreground">
zafu operates as a minimal qr bridge for zafu zigner by default.
            these settings control opt-in features that query the network.
          </p>
        </div>

        {/* network privacy tiers */}
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
          <p className="text-sm font-medium text-green-400">shielded (always safe)</p>
          <p className="text-xs text-muted-foreground mt-1">
            {SHIELDED_NETWORKS.join(', ')} - trial decryption, downloads all blocks
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            rpc never learns which notes/addresses belong to you
          </p>
        </div>

        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
          <p className="text-sm font-medium text-blue-400">light client (p2p)</p>
          <p className="text-xs text-muted-foreground mt-1">
            {LIGHT_CLIENT_NETWORKS.join(', ')} - smoldot embedded, no central rpc
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            connects directly to p2p network, queries distributed across peers
          </p>
        </div>

        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
          <p className="text-sm font-medium text-yellow-400">transparent (opt-in)</p>
          <p className="text-xs text-muted-foreground mt-1">
            {TRANSPARENT_NETWORKS.join(', ')} - queries specific addresses to rpc
          </p>
        </div>

        {/* settings - only for cosmos (transparent) */}
        <div className="border-t border-border pt-4">
          <SettingRow
            label="cosmos balance queries"
            description="fetch balances for cosmos chains. leaks addresses to rpc nodes."
            checked={settings.enableTransparentBalances}
            onChange={(v) => setSetting('enableTransparentBalances', v)}
            warning
          />

          <SettingRow
            label="transaction history"
            description="store and display past transactions locally."
            checked={settings.enableTransactionHistory}
            onChange={(v) => setSetting('enableTransactionHistory', v)}
            warning
          />

          <SettingRow
            label="cosmos background sync"
            description="periodically sync cosmos state. shielded and light client networks sync automatically."
            checked={settings.enableBackgroundSync}
            onChange={(v) => setSetting('enableBackgroundSync', v)}
            warning
          />

          <SettingRow
            label="price fetching"
            description="show fiat prices. price apis don't know your addresses."
            checked={settings.enablePriceFetching}
            onChange={(v) => setSetting('enablePriceFetching', v)}
          />
        </div>

        {/* status */}
        {hasLeakyFeatures() ? (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-center">
            <p className="text-sm text-yellow-400">
              some features enabled that may leak metadata
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-center">
            <p className="text-sm text-green-400">
              maximum privacy mode - minimal network footprint
            </p>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
}
