import { useState } from 'react';
import { WalletSwitcher } from './wallet-switcher';
import { NetworkSelector, NetworkInfo, SUPPORTED_NETWORKS } from '../../../components/network-selector';

export const IndexHeader = () => {
  const [currentNetwork, setCurrentNetwork] = useState<NetworkInfo>(SUPPORTED_NETWORKS[0]!);

  return (
    <header className='flex items-center justify-between gap-2 px-4 py-2'>
      <WalletSwitcher />
      <NetworkSelector
        currentNetwork={currentNetwork}
        onNetworkChange={setCurrentNetwork}
        networks={SUPPORTED_NETWORKS}
      />
    </header>
  );
};
