import { useMemo, useState } from 'react';
import { SettingsScreen } from './settings-screen';
import { useStore } from '../../../state';
import { networksSelector, type NetworkConfig, type NetworkId } from '../../../state/networks';
import { CURATED_ZCASH_ENDPOINTS, type CuratedEndpoint } from '../../../state/keyring/endpoint-registry';
import { measureCuratedLatencies, type EndpointLatency } from '../../../state/keyring/endpoint-latency';

export const SettingsNetworkEndpoints = () => {
  const { networks, setNetworkEndpoint } = useStore(networksSelector);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingEndpoints, setEditingEndpoints] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [latencies, setLatencies] = useState<EndpointLatency[] | null>(null);

  const handleSave = async (networkId: NetworkId) => {
    const newEndpoint = editingEndpoints[networkId];
    if (!newEndpoint) return;

    setSaving(networkId);
    try {
      await setNetworkEndpoint(networkId, newEndpoint);
      setEditingEndpoints(prev => {
        const next = { ...prev };
        delete next[networkId];
        return next;
      });
    } finally {
      setSaving(null);
    }
  };

  const handleTestLatencies = async () => {
    setTesting(true);
    try {
      const results = await measureCuratedLatencies();
      setLatencies(results);
    } finally {
      setTesting(false);
    }
  };

  const latencyByUrl = useMemo(() => {
    const m = new Map<string, EndpointLatency>();
    latencies?.forEach(l => m.set(l.url, l));
    return m;
  }, [latencies]);

  // Sort curated by RTT once measured; default order otherwise.
  const sortedCurated: ReadonlyArray<CuratedEndpoint> = useMemo(() => {
    if (!latencies) return CURATED_ZCASH_ENDPOINTS;
    return [...CURATED_ZCASH_ENDPOINTS].sort((a, b) => {
      const la = latencyByUrl.get(a.url)?.rttMs;
      const lb = latencyByUrl.get(b.url)?.rttMs;
      if (la == null && lb == null) return 0;
      if (la == null) return 1;
      if (lb == null) return -1;
      return la - lb;
    });
  }, [latencies, latencyByUrl]);

  const enabledNetworks: NetworkConfig[] = Object.values(networks).filter((n): n is NetworkConfig => n.enabled);

  return (
    <SettingsScreen title='network endpoints'>
      <div className="flex flex-col gap-4">
        {enabledNetworks.length === 0 ? (
          <p className="text-fg-muted text-sm">
            No networks enabled. Enable networks in settings to configure endpoints.
          </p>
        ) : (
          enabledNetworks.map((network: NetworkConfig) => (
            <div key={network.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  {network.name}
                  {network.id === 'zcash' && network.backend === 'lightwalletd' ? (
                    <span className="ml-2 text-xs text-amber-400">(general public endpoint)</span>
                  ) : network.syncDescription && (
                    <span className="ml-2 text-xs text-green-400">(trustless)</span>
                  )}
                </label>
                <span className="text-xs text-fg-muted">{network.symbol}</span>
              </div>

              {network.id === 'zcash' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-fg-muted">Curated endpoints</span>
                    <button
                      onClick={handleTestLatencies}
                      disabled={testing}
                      className="text-xs text-zigner-gold hover:underline disabled:opacity-50"
                    >
                      {testing ? 'testing...' : latencies ? 'retest' : 'test latencies'}
                    </button>
                  </div>
                  {sortedCurated.map(ep => {
                    const lat = latencyByUrl.get(ep.url);
                    const isCurrent = (editingEndpoints[network.id] ?? network.endpoint) === ep.url;
                    return (
                      <button
                        key={ep.url}
                        type="button"
                        onClick={() => setEditingEndpoints(prev => ({ ...prev, [network.id]: ep.url }))}
                        className={`flex items-center justify-between text-left rounded-lg border bg-input px-3 py-2 text-sm transition-colors hover:border-zigner-gold ${
                          isCurrent ? 'border-zigner-gold' : 'border-border-soft'
                        }`}
                      >
                        <div className="flex flex-col">
                          <span className="text-sm">{ep.label}</span>
                          <span className="text-xs text-fg-muted">{ep.url}</span>
                        </div>
                        <div className="flex flex-col items-end gap-0.5">
                          <span className={`text-xs ${ep.backend === 'zidecar' ? 'text-green-400' : 'text-amber-400'}`}>
                            {ep.backend === 'zidecar' ? 'trustless' : 'trusted'}
                          </span>
                          {lat && (
                            <span className={`text-xs ${lat.rttMs === null ? 'text-red-400' : 'text-fg-muted'}`}>
                              {lat.rttMs === null ? 'unreachable' : `${lat.rttMs}ms`}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={editingEndpoints[network.id] ?? network.endpoint ?? ''}
                  onChange={e => setEditingEndpoints(prev => ({
                    ...prev,
                    [network.id]: e.target.value,
                  }))}
                  placeholder={`Enter ${network.name} endpoint`}
                  className="flex-1 rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-zigner-gold focus:outline-none"
                />
                {editingEndpoints[network.id] !== undefined && (
                  <button
                    onClick={() => handleSave(network.id)}
                    disabled={saving === network.id}
                    className="rounded-lg bg-zigner-gold px-3 py-2 text-sm text-zigner-dark hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {saving === network.id ? '...' : 'Save'}
                  </button>
                )}
              </div>
              {network.id === 'zcash' && network.backend === 'lightwalletd' ? (
                <p className="text-xs text-amber-400/80">
                  Generic lightwalletd endpoint — sync works, but this server is trusted for chain tip, balance and spent-status (no trustless header/commitment/nullifier proofs). Compact blocks are still trial-decrypted locally; keys never leave this device.
                </p>
              ) : network.syncDescription && (
                <p className="text-xs text-fg-muted">
                  {network.syncDescription}
                </p>
              )}
            </div>
          ))
        )}

        {enabledNetworks.length > 0 && (
          <div className="mt-4 border-t border-border-soft pt-4">
            <h3 className="text-sm font-medium mb-2">Default Endpoints</h3>
            <div className="text-xs text-fg-muted space-y-1">
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
