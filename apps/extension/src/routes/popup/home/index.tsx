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

import { BackupNudge } from './notices';
import { PenumbraContent } from './penumbra-home';
import { ZcashContent } from './zcash-home';

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

  // a burner chain is penumbra's plumbing: an older wallet left on one sees penumbra
  const Home = HOME[activeNetwork] ?? PenumbraHome;
  return (
    <Suspense fallback={<AssetListSkeleton rows={4} />}>
      <Home nudge={backupNudge} />
    </Suspense>
  );
};
