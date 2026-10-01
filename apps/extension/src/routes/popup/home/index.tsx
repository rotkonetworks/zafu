import { InFlightCard } from '../../../components/in-flight-card';
import { Suspense, useState, useCallback, useEffect } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  type NetworkType,
} from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

import { BackupNudge } from './notices';
import { HomeActions } from './actions';
import { HistoryContent } from './history';
import { PenumbraContent } from './penumbra-home';
import { ZcashContent } from './zcash-home';
import { CosmosContent, NetworkPlaceholder } from './other-networks';

export const popupIndexLoader = async (): Promise<Response | null> =>
  (await needsOnboard()) ?? (await needsLogin()) ?? null;

const ZcashHome = ({ nudge }: { nudge?: ReactNode }) => {
  const key = useStore(selectEffectiveKeyInfo);
  const wallet = useStore(selectActiveZcashWallet);
  return (
    <ZcashContent
      hasMnemonic={key?.type === 'mnemonic'}
      // mnemonic vaults derive zcash keys directly - no zcash wallet record
      watchOnly={key?.type === 'mnemonic' ? undefined : wallet}
      nudge={nudge}
    />
  );
};

const PenumbraHome = ({ nudge }: { nudge?: ReactNode }) => (
  <PenumbraContent account={useStore(selectPenumbraAccount)} nudge={nudge} />
);

/** the shielded networks share one home (home-screen.tsx), each reading its own state */
const HOME: Partial<Record<NetworkType, ComponentType<{ nudge?: ReactNode }>>> = {
  zcash: ZcashHome,
  penumbra: PenumbraHome,
};

export const PopupIndex = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const navigate = useNavigate();

  // preload balances in background for instant display
  usePreloadBalances(penumbraAccount);

  // Backup nudge: shown for mnemonic vaults until the user demonstrably
  // possesses their recovery phrase (onboarding checkbox, import, settings
  // reveal, or explicit dismissal here). A fresh key, because the old
  // `backupReminderSeen` is poisoned `true` for every pre-fix wallet.
  const [showBackupNudge, setShowBackupNudge] = useState(false);
  useEffect(() => {
    if (selectedKeyInfo?.type !== 'mnemonic') {
      setShowBackupNudge(false);
      return;
    }
    void localExtStorage.get('seedPhraseBackedUp').then(done => {
      setShowBackupNudge(done !== true);
    });
  }, [selectedKeyInfo?.type, selectedKeyInfo?.id]);
  const dismissBackupNudge = useCallback(() => {
    setShowBackupNudge(false);
    void localExtStorage.set('seedPhraseBackedUp', true);
  }, []);

  const backupNudge = showBackupNudge ? (
    <BackupNudge
      onBackUp={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
      onDismiss={dismissBackupNudge}
    />
  ) : null;

  const Home = HOME[activeNetwork];
  if (Home) {
    return (
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <Home nudge={backupNudge} />
      </Suspense>
    );
  }

  return (
    <div className='flex min-h-full flex-col gap-3 p-4'>
      <InFlightCard />
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <NetworkContent network={activeNetwork} nudge={backupNudge} />
      </Suspense>
      <Suspense fallback={<AssetListSkeleton rows={3} />}>
        <HistoryContent network={activeNetwork} penumbraAccount={penumbraAccount} limit={3} />
      </Suspense>
    </div>
  );
};

/** network-specific content - split out to minimize re-renders */
const NetworkContent = ({ network, nudge }: { network: NetworkType; nudge?: ReactNode }) => (
  <>
    {nudge}
    <HomeActions />
    {network === 'noble' || network === 'cosmoshub' ? (
      <CosmosContent chainId={network as CosmosChainId} />
    ) : (
      <NetworkPlaceholder network={network} />
    )}
  </>
);
