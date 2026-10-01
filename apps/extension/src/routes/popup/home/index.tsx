import { InFlightCard } from '../../../components/in-flight-card';
import { Suspense, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  selectSetPenumbraAccount,
  type NetworkType,
} from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import { usePolkadotPublicKey } from '../../../hooks/use-polkadot-key';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

import { BackupNudge } from './notices';
import { HomeActions } from './actions';
import { HistoryContent } from './history';
import { PenumbraContent } from './penumbra-home';
import { ZcashContent } from './zcash-home';
import { PolkadotContent, CosmosContent, NetworkPlaceholder } from './other-networks';

export interface PopupLoaderData {
  fullSyncHeight?: number;
}

export const popupIndexLoader = async (): Promise<Response | PopupLoaderData> => {
  await needsOnboard();
  const redirect = await needsLogin();
  if (redirect) {
    return redirect;
  }
  return { fullSyncHeight: await localExtStorage.get('fullSyncHeight') };
};

export const PopupIndex = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const setPenumbraAccount = useStore(selectSetPenumbraAccount);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const { publicKey: polkadotPublicKey } = usePolkadotPublicKey();
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

  // zcash lays out its own screen (sync strip, hero, pools, activity)
  if (activeNetwork === 'zcash') {
    return (
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <ZcashContent
          hasMnemonic={selectedKeyInfo?.type === 'mnemonic'}
          // mnemonic vaults derive zcash keys directly - no zcash wallet record
          watchOnly={selectedKeyInfo?.type === 'mnemonic' ? undefined : activeZcashWallet}
          nudge={backupNudge}
        />
      </Suspense>
    );
  }

  return (
    <div className='flex min-h-full flex-col gap-3 p-4'>
      <InFlightCard />
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <NetworkContent
          network={activeNetwork}
          penumbraAccount={penumbraAccount}
          setPenumbraAccount={setPenumbraAccount}
          polkadotPublicKey={polkadotPublicKey}
          nudge={backupNudge}
        />
      </Suspense>
      <Suspense fallback={<AssetListSkeleton rows={3} />}>
        <HistoryContent network={activeNetwork} penumbraAccount={penumbraAccount} limit={3} />
      </Suspense>
    </div>
  );
};

/** network-specific content - split out to minimize re-renders */
const NetworkContent = ({
  network,
  penumbraAccount,
  setPenumbraAccount,
  polkadotPublicKey,
  nudge,
}: {
  network: NetworkType;
  penumbraAccount: number;
  setPenumbraAccount: (n: number) => void;
  polkadotPublicKey?: string;
  nudge?: ReactNode;
}) => {
  if (network === 'penumbra') {
    return (
      <PenumbraContent
        account={penumbraAccount}
        onAccountChange={setPenumbraAccount}
        actions={<HomeActions />}
        nudge={nudge}
      />
    );
  }
  return (
    <>
      {nudge}
      <HomeActions />
      {network === 'polkadot' || network === 'kusama' ? (
        <PolkadotContent
          publicKey={polkadotPublicKey}
          relay={network === 'kusama' ? 'kusama' : undefined}
        />
      ) : network === 'noble' || network === 'cosmoshub' ? (
        <CosmosContent chainId={network as CosmosChainId} />
      ) : (
        <NetworkPlaceholder network={network} />
      )}
    </>
  );
};
