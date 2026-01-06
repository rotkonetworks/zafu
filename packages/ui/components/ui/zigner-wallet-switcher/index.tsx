/**
 * zigner wallet switcher component
 *
 * allows switching between multiple zigner wallets and shows network badges
 * for each wallet indicating which networks are enabled.
 */

import { ChevronDown, Plus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../lib/utils';
import { Button } from '../button';

// network types and colors
type NetworkType = 'penumbra' | 'zcash' | 'polkadot' | 'cosmos';

interface NetworkBadgeInfo {
  type: NetworkType;
  name: string;
  color: string;
}

const NETWORK_BADGES: Record<NetworkType, NetworkBadgeInfo> = {
  penumbra: { type: 'penumbra', name: 'Penumbra', color: '#E11D48' },
  zcash: { type: 'zcash', name: 'Zcash', color: '#F4B728' },
  polkadot: { type: 'polkadot', name: 'Polkadot', color: '#E6007A' },
  cosmos: { type: 'cosmos', name: 'Cosmos', color: '#6F7390' },
};

// wallet info for display
export interface ZignerWalletInfo {
  id: string;
  label: string;
  zignerAccountIndex: number;
  enabledNetworks: NetworkType[];
}

export interface ZignerWalletSwitcherProps {
  /** list of all wallets */
  wallets: ZignerWalletInfo[];
  /** index of currently active wallet */
  activeIndex: number;
  /** callback when user selects a wallet */
  onSelect: (index: number) => void;
  /** callback when user wants to add a new wallet */
  onAddWallet?: () => void;
  /** whether to show the add wallet button */
  showAddButton?: boolean;
}

/** network badge showing which networks are enabled */
function NetworkBadge({ network }: { network: NetworkType }) {
  const info = NETWORK_BADGES[network];
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: info.color }}
      title={info.name}
    />
  );
}

/** single wallet item in the list */
function WalletItem({
  wallet,
  isActive,
  onClick,
}: {
  wallet: ZignerWalletInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2 flex items-center justify-between rounded-lg transition-colors',
        'hover:bg-muted/50',
        isActive && 'bg-muted',
      )}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
          <Wallet className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="text-left">
          <p className="text-sm font-medium">{wallet.label}</p>
          <p className="text-xs text-muted-foreground">
            Account #{wallet.zignerAccountIndex}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {wallet.enabledNetworks.map((network) => (
          <NetworkBadge key={network} network={network} />
        ))}
      </div>
    </button>
  );
}

/** main wallet switcher component */
export function ZignerWalletSwitcher({
  wallets,
  activeIndex,
  onSelect,
  onAddWallet,
  showAddButton = true,
}: ZignerWalletSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const activeWallet = wallets[activeIndex];

  if (!activeWallet) {
    return (
      <Button variant="outline" onClick={onAddWallet} className="gap-2">
        <Plus className="w-4 h-4" />
        import wallet from zigner
      </Button>
    );
  }

  return (
    <div className="relative">
      {/* trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
          'hover:bg-muted/50 border border-border',
        )}
      >
        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
          <Wallet className="w-3 h-3 text-muted-foreground" />
        </div>
        <span className="text-sm font-medium max-w-[120px] truncate">
          {activeWallet.label}
        </span>
        <div className="flex items-center gap-1">
          {activeWallet.enabledNetworks.map((network) => (
            <NetworkBadge key={network} network={network} />
          ))}
        </div>
        <ChevronDown
          className={cn(
            'w-4 h-4 text-muted-foreground transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {/* dropdown */}
      {isOpen && (
        <>
          {/* backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* dropdown content */}
          <div
            className={cn(
              'absolute top-full left-0 mt-1 w-64 z-50',
              'bg-card border border-border rounded-lg shadow-lg',
              'py-1',
            )}
          >
            <div className="px-3 py-2 border-b border-border">
              <p className="text-xs text-muted-foreground font-medium uppercase">
                zigner wallets
              </p>
            </div>

            <div className="py-1 max-h-64 overflow-y-auto">
              {wallets.map((wallet, index) => (
                <WalletItem
                  key={wallet.id}
                  wallet={wallet}
                  isActive={index === activeIndex}
                  onClick={() => {
                    onSelect(index);
                    setIsOpen(false);
                  }}
                />
              ))}
            </div>

            {showAddButton && onAddWallet && (
              <div className="border-t border-border pt-1 px-1">
                <button
                  onClick={() => {
                    onAddWallet();
                    setIsOpen(false);
                  }}
                  className={cn(
                    'w-full px-3 py-2 flex items-center gap-2 rounded-lg',
                    'text-sm text-muted-foreground hover:text-foreground',
                    'hover:bg-muted/50 transition-colors',
                  )}
                >
                  <Plus className="w-4 h-4" />
                  import new wallet from zigner
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default ZignerWalletSwitcher;
