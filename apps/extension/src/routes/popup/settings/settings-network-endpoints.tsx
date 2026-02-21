import { useState } from 'react';
import { ShareGradientIcon } from '../../../icons/share-gradient';
import { SettingsScreen } from './settings-screen';
import { useStore } from '../../../state';
import { networksSelector, type NetworkConfig, type NetworkId } from '../../../state/networks';

export const SettingsNetworkEndpoints = () => {
  const { networks, setNetworkEndpoint } = useStore(networksSelector);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingEndpoints, setEditingEndpoints] = useState<Record<string, string>>({});

  const handleSave = async (networkId: NetworkId) => {
    const newEndpoint = editingEndpoints[networkId];
    if (!newEndpoint) return;

    setSaving(networkId);
    try {
      await setNetworkEndpoint(networkId, newEndpoint);
      // Clear editing state after save
      setEditingEndpoints(prev => {
        const next = { ...prev };
        delete next[networkId];
        return next;
      });
    } finally {
      setSaving(null);
    }
  };

  const enabledNetworks: NetworkConfig[] = Object.values(networks).filter((n): n is NetworkConfig => n.enabled);

  return (
    <SettingsScreen title="Network Endpoints" IconComponent={ShareGradientIcon}>
      <div className="flex flex-col gap-4">
        {enabledNetworks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No networks enabled. Enable networks in settings to configure endpoints.
          </p>
        ) : (
          enabledNetworks.map((network: NetworkConfig) => (
            <div key={network.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  {network.name}
                  {network.syncDescription && (
                    <span className="ml-2 text-xs text-green-500">(trustless)</span>
                  )}
                </label>
                <span className="text-xs text-muted-foreground">{network.symbol}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={editingEndpoints[network.id] ?? network.endpoint ?? ''}
                  onChange={e => setEditingEndpoints(prev => ({
                    ...prev,
                    [network.id]: e.target.value,
                  }))}
                  placeholder={`Enter ${network.name} endpoint`}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {editingEndpoints[network.id] !== undefined && (
                  <button
                    onClick={() => handleSave(network.id)}
                    disabled={saving === network.id}
                    className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {saving === network.id ? '...' : 'Save'}
                  </button>
                )}
              </div>
              {network.syncDescription && (
                <p className="text-xs text-muted-foreground">
                  {network.syncDescription}
                </p>
              )}
            </div>
          ))
        )}

        {enabledNetworks.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-medium mb-2">Default Endpoints</h3>
            <div className="text-xs text-muted-foreground space-y-1">
              {networks.zcash?.enabled && <p><strong>Zcash:</strong> https://zcash.rotko.net (zidecar)</p>}
              {networks.penumbra?.enabled && <p><strong>Penumbra:</strong> https://penumbra.rotko.net</p>}
              {networks.polkadot?.enabled && <p><strong>Polkadot:</strong> wss://rpc.polkadot.io (light client)</p>}
              {networks.ethereum?.enabled && <p><strong>Ethereum:</strong> https://eth.llamarpc.com</p>}
              {networks.bitcoin?.enabled && <p><strong>Bitcoin:</strong> https://mempool.space</p>}
            </div>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};
