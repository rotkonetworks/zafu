/**
 * settings page for managing polkadot/kusama parachains
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CheckIcon, ReloadIcon, TrashIcon, UploadIcon } from '@radix-ui/react-icons';
import { cn } from '@repo/ui/lib/utils';
import {
  fetchAvailableParachains,
  type ParachainInfo,
  type RelayNetwork,
} from '@repo/wallet/networks/polkadot/parachain-registry';
import { localExtStorage } from '@repo/storage-chrome/local';

interface CustomChainspec {
  id: string;
  name: string;
  /** relay chain - paseo is polkadot ecosystem testnet */
  relay: 'polkadot' | 'kusama' | 'paseo' | 'standalone';
  symbol?: string;
  decimals?: number;
  chainspec: string;
  addedAt: number;
}

export const SettingsParachains = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<RelayNetwork | 'custom'>('polkadot');
  const [parachains, setParachains] = useState<ParachainInfo[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [customChains, setCustomChains] = useState<CustomChainspec[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // load parachains and enabled state
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // load custom chains
        const custom = await localExtStorage.get('customChainspecs');
        setCustomChains(custom ?? []);

        if (activeTab === 'custom') {
          setParachains([]);
          setEnabledIds(new Set());
        } else {
          const chains = await fetchAvailableParachains(activeTab);
          setParachains(chains);

          // load enabled parachains from storage
          const stored = await localExtStorage.get('enabledParachains');
          const enabledForRelay = activeTab === 'polkadot' ? stored?.polkadot : stored?.kusama;
          setEnabledIds(new Set(enabledForRelay ?? []));
        }
      } catch (err) {
        console.error('failed to load parachains:', err);
      }
      setLoading(false);
    };
    void load();
  }, [activeTab]);

  const handleToggle = async (chainId: string) => {
    if (activeTab === 'custom') return;
    const newEnabled = new Set(enabledIds);
    if (newEnabled.has(chainId)) {
      newEnabled.delete(chainId);
    } else {
      newEnabled.add(chainId);
    }
    setEnabledIds(newEnabled);

    // persist to storage
    const stored = (await localExtStorage.get('enabledParachains')) ?? {};
    const updated = {
      ...stored,
      [activeTab]: Array.from(newEnabled),
    };
    await localExtStorage.set('enabledParachains', updated);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const spec = JSON.parse(text);

      // extract name from chainspec
      const name = spec.name || spec.id || file.name.replace('.json', '');
      const id = `custom-${Date.now()}`;

      // try to extract token info from properties
      const properties = spec.properties || {};
      const symbol = properties.tokenSymbol?.[0] || properties.tokenSymbol;
      const decimals = properties.tokenDecimals?.[0] || properties.tokenDecimals;

      // auto-detect relay from chainspec
      // parachains have relay_chain field: "polkadot", "kusama", "paseo", etc.
      // relay chains and standalone chains don't have this field
      let relay: 'polkadot' | 'kusama' | 'paseo' | 'standalone' = 'standalone';
      if (spec.relay_chain) {
        const relayChain = spec.relay_chain.toLowerCase();
        if (relayChain.includes('polkadot')) {
          relay = 'polkadot';
        } else if (relayChain.includes('kusama') || relayChain === 'ksmcc3') {
          relay = 'kusama';
        } else if (relayChain.includes('paseo')) {
          relay = 'paseo';
        }
      }

      const newChain: CustomChainspec = {
        id,
        name,
        relay,
        symbol,
        decimals,
        chainspec: text,
        addedAt: Date.now(),
      };

      const updated = [...customChains, newChain];
      setCustomChains(updated);
      await localExtStorage.set('customChainspecs', updated);

      // reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error('failed to parse chainspec:', err);
      alert('invalid chainspec JSON file');
    }
  };

  const handleDeleteCustom = async (id: string) => {
    const updated = customChains.filter(c => c.id !== id);
    setCustomChains(updated);
    await localExtStorage.set('customChainspecs', updated);
  };

  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(-1)}
          className='text-muted-foreground transition-colors hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium'>parachains</h1>
      </div>

      {/* tabs */}
      <div className='flex border-b border-border/40'>
        {(['polkadot', 'kusama', 'custom'] as (RelayNetwork | 'custom')[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 py-2 text-sm font-medium transition-colors',
              activeTab === tab
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* content */}
      <div className='flex-1 overflow-y-auto p-4'>
        {activeTab === 'custom' ? (
          <div className='flex flex-col gap-3'>
            {/* file upload */}
            <input
              ref={fileInputRef}
              type='file'
              accept='.json'
              onChange={e => void handleFileUpload(e)}
              className='hidden'
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className='flex items-center justify-center gap-2 p-3 border border-dashed border-border/60 hover:border-primary/50 hover:bg-muted/30 transition-colors'
            >
              <UploadIcon className='h-4 w-4' />
              <span className='text-sm'>upload chainspec json</span>
            </button>

            {customChains.length === 0 ? (
              <div className='text-center text-sm text-muted-foreground py-8'>
                no custom chainspecs added
              </div>
            ) : (
              <div className='flex flex-col gap-1'>
                <div className='mb-2 text-xs text-muted-foreground'>
                  {customChains.length} custom chain{customChains.length !== 1 ? 's' : ''}
                </div>
                {customChains.map(chain => (
                  <div
                    key={chain.id}
                    className='flex items-center justify-between p-3 border border-border/40 text-left'
                  >
                    <div className='flex flex-col'>
                      <span className='font-medium text-sm'>{chain.name}</span>
                      <span className='text-xs text-muted-foreground'>
                        {chain.symbol ?? 'unknown'} • {chain.relay}
                      </span>
                    </div>
                    <button
                      onClick={() => void handleDeleteCustom(chain.id)}
                      className='p-2 text-muted-foreground hover:text-destructive transition-colors'
                    >
                      <TrashIcon className='h-4 w-4' />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className='flex items-center justify-center py-8'>
            <ReloadIcon className='h-5 w-5 animate-spin text-muted-foreground' />
          </div>
        ) : parachains.length === 0 ? (
          <div className='text-center text-sm text-muted-foreground py-8'>
            no parachains available
          </div>
        ) : (
          <div className='flex flex-col gap-1'>
            <div className='mb-2 text-xs text-muted-foreground'>
              {parachains.length} parachains available
            </div>
            {parachains.map(chain => {
              const isEnabled = enabledIds.has(chain.id);
              return (
                <button
                  key={chain.id}
                  onClick={() => void handleToggle(chain.id)}
                  className={cn(
                    'flex items-center justify-between p-3 border border-border/40 transition-colors text-left',
                    isEnabled ? 'bg-primary/5 border-primary/30' : 'hover:bg-muted/30'
                  )}
                >
                  <div className='flex flex-col'>
                    <span className='font-medium text-sm'>{chain.name}</span>
                    {chain.symbol && (
                      <span className='text-xs text-muted-foreground'>{chain.symbol}</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      'h-5 w-5 rounded border-2 flex items-center justify-center transition-colors',
                      isEnabled ? 'border-primary bg-primary' : 'border-muted-foreground/50'
                    )}
                  >
                    {isEnabled && <CheckIcon className='h-3 w-3 text-primary-foreground' />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className='p-4 border-t border-border/40'>
        <p className='text-xs text-muted-foreground text-center'>
          chainspecs from paritytech.github.io/chainspecs
        </p>
      </div>
    </div>
  );
};

export default SettingsParachains;
