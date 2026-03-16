import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Services } from '@repo/context';
import {
  isZignerServicesMessage,
  isClearCacheRequest,
  ServicesMessage,
  type ClearCacheRequest,
  type ClearCacheProgress,
  type ClearCacheStep,
  PENUMBRA_CLEAR_STEPS,
  ZCASH_CLEAR_STEPS,
} from '../services';
import { isValidInternalSender } from '../../senders/internal';
import { localExtStorage } from '@repo/storage-chrome/local';

/** Broadcast progress to all extension pages */
function broadcastProgress(step: ClearCacheStep, completed: number, total: number): void {
  const progress: ClearCacheProgress = {
    type: 'ClearCacheProgress',
    step,
    completed,
    total,
  };
  void chrome.runtime.sendMessage(progress).catch(() => {});
}

async function clearPenumbraCache(walletServices: Promise<Services>): Promise<void> {
  const steps = PENUMBRA_CLEAR_STEPS;
  let completed = 0;

  await localExtStorage.set('clearingCache', true);

  broadcastProgress('stopping', completed, steps.length);
  const { blockProcessor, indexedDb } = await walletServices.then(ws =>
    ws.getWalletServices(),
  );
  blockProcessor.stop('clearCache');
  completed++;

  broadcastProgress('clearing-params', completed, steps.length);
  await localExtStorage.remove('params');
  completed++;

  broadcastProgress('clearing-database', completed, steps.length);
  await indexedDb.clear();
  completed++;

  broadcastProgress('clearing-sync-state', completed, steps.length);
  await Promise.all([
    localExtStorage.remove('fullSyncHeight'),
    localExtStorage.remove('compactFrontierBlockHeight'),
  ]);
  completed++;

  await localExtStorage.remove('clearingCache');
  broadcastProgress('reloading', completed, steps.length);
}

async function clearZcashCache(): Promise<void> {
  const steps = ZCASH_CLEAR_STEPS;
  let completed = 0;

  await localExtStorage.set('clearingCache', true);

  broadcastProgress('clearing-database', completed, steps.length);
  try { indexedDB.deleteDatabase('zafu-zcash'); } catch {}
  try { indexedDB.deleteDatabase('zafu-memo-cache'); } catch {}
  completed++;

  broadcastProgress('clearing-sync-state', completed, steps.length);
  // zcash sync state is inside the IndexedDB, no separate storage keys
  completed++;

  await localExtStorage.remove('clearingCache');
  broadcastProgress('reloading', completed, steps.length);
}

export const internalServiceListener = (
  walletServices: Promise<Services>,
  req: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response?: unknown) => void,
): boolean => {
  if (!isValidInternalSender(sender)) {
    return false;
  }

  // network-scoped clear cache request
  if (isClearCacheRequest(req)) {
    const { network } = req as ClearCacheRequest;
    void (async () => {
      if (network === 'penumbra') {
        await clearPenumbraCache(walletServices);
      } else {
        await clearZcashCache();
      }
    })()
      .then(() => respond())
      .finally(() => chrome.runtime.reload());
    return true;
  }

  if (!isZignerServicesMessage(req)) {
    return false;
  }

  switch (ServicesMessage[req as keyof typeof ServicesMessage]) {
    // legacy unscoped clear cache — clear penumbra (backwards compat)
    case ServicesMessage.ClearCache:
      void clearPenumbraCache(walletServices)
        .then(() => respond())
        .finally(() => chrome.runtime.reload());
      break;
    case ServicesMessage.ChangeNumeraires:
      void (async () => {
        const { blockProcessor, indexedDb } = await walletServices.then(ws =>
          ws.getWalletServices(),
        );
        const newNumeraires = await localExtStorage.get('numeraires');
        blockProcessor.setNumeraires(newNumeraires.map(n => AssetId.fromJsonString(n)));
        await indexedDb.clearSwapBasedPrices();
      })().then(() => respond());
      break;
  }

  return true;
};
