import { Suspense } from 'react';
import type { ComponentType, ReactNode } from 'react';

import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectEffectiveWalletId,
  selectPenumbraAccount,
  type NetworkType,
} from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { needsLogin, needsOnboard } from '../popup-needs';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';

import { useBackupNudge } from './notices';
import { PenumbraContent } from './penumbra-home';
import { NoPenumbraKey, penumbraKeyGap } from './no-penumbra-key';
import { ZcashContent } from './zcash-home';
import { HyperliquidHome } from './hyperliquid-home';

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

const PenumbraHome = ({ nudge }: { nudge?: ReactNode }) => {
  const account = useStore(selectPenumbraAccount);
  const key = useStore(selectEffectiveKeyInfo);
  const gap = useStore(s => penumbraKeyGap(key, s.wallets.all));
  return gap && key ? (
    <NoPenumbraKey gap={gap} name={key.name} />
  ) : (
    <PenumbraContent account={account} nudge={nudge} />
  );
};

/** every network shares one home (home-screen.tsx), each reading its own state */
const HOME: Partial<Record<NetworkType, ComponentType<{ nudge?: ReactNode }>>> = {
  zcash: ZcashHome,
  penumbra: PenumbraHome,
  hyperliquid: HyperliquidHome,
};

export const PopupIndex = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const wallet = useStore(selectEffectiveWalletId);

  // preload balances in background for instant display
  usePreloadBalances(wallet, penumbraAccount);

  const backupNudge = useBackupNudge();

  // a burner chain is penumbra's plumbing: an older wallet left on one sees penumbra
  const Home = HOME[activeNetwork] ?? PenumbraHome;
  return (
    <Suspense fallback={<AssetListSkeleton rows={4} />}>
      <Home nudge={backupNudge} />
    </Suspense>
  );
};
