import { useState } from 'react';
import { motion } from 'framer-motion';
import { WalletSwitcher } from './wallet-switcher';
import { NetworkSelector, NetworkInfo, SUPPORTED_NETWORKS } from '../../../components/network-selector';

export const IndexHeader = () => {
  const [currentNetwork, setCurrentNetwork] = useState<NetworkInfo>(SUPPORTED_NETWORKS[0]!);

  const handleNetworkChange = (network: NetworkInfo) => {
    setCurrentNetwork(network);
    // TODO: Update global network state and refresh data
  };

  return (
    <header className='sticky top-0 z-40 w-full bg-background/80 backdrop-blur-sm'>
      <div className='flex items-center justify-between gap-2 px-4 py-3'>
        {/* Wallet Switcher - Left */}
        <div className='flex-1'>
          <WalletSwitcher />
        </div>

        {/* Network Selector - Right */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.3 } }}
        >
          <NetworkSelector
            currentNetwork={currentNetwork}
            onNetworkChange={handleNetworkChange}
            networks={SUPPORTED_NETWORKS}
          />
        </motion.div>
      </div>
    </header>
  );
};
