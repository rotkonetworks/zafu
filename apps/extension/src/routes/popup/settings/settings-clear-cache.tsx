import {
  getClearCacheStepLabel,
  PENUMBRA_CLEAR_STEPS,
  ZCASH_CLEAR_STEPS,
  type ClearCacheProgress,
  type ClearCacheRequest,
  type ClearCacheStep,
} from '../../../message/services';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { useState, useEffect } from 'react';
import { SettingsScreen } from './settings-screen';
import { localExtStorage } from '@repo/storage-chrome/local';

interface ClearingState {
  inProgress: boolean;
  step: ClearCacheStep;
  completed: number;
  total: number;
}

const useCacheClear = () => {
  const navigate = usePopupNav();
  const activeNetwork = useStore(selectActiveNetwork);
  const isZcash = activeNetwork === 'zcash';
  const clearNetwork = isZcash ? 'zcash' : 'penumbra';
  const steps = isZcash ? ZCASH_CLEAR_STEPS : PENUMBRA_CLEAR_STEPS;

  const [clearingState, setClearingState] = useState<ClearingState>({
    inProgress: false,
    step: 'stopping',
    completed: 0,
    total: steps.length,
  });

  useEffect(() => {
    void localExtStorage.get('clearingCache').then(wasClearing => {
      if (wasClearing) {
        setClearingState({
          inProgress: true,
          step: 'clearing-database',
          completed: 1,
          total: steps.length,
        });
        const req: ClearCacheRequest = { type: 'ClearCache', network: clearNetwork };
        void chrome.runtime.sendMessage(req);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type: string }).type === 'ClearCacheProgress'
      ) {
        const progress = message as ClearCacheProgress;
        setClearingState({
          inProgress: true,
          step: progress.step,
          completed: progress.completed,
          total: progress.total,
        });
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const handleCacheClear = () => {
    setClearingState(prev => ({ ...prev, inProgress: true }));

    void (async function () {
      const req: ClearCacheRequest = { type: 'ClearCache', network: clearNetwork };
      await chrome.runtime.sendMessage(req);
      if (!isZcash) {
        useStore.setState(state => {
          state.network.fullSyncHeight = undefined;
        });
      }
      navigate(PopupPath.INDEX);
    })();
  };

  return { handleCacheClear, clearingState, clearNetwork };
};

export const SettingsClearCache = () => {
  const { handleCacheClear, clearingState, clearNetwork } = useCacheClear();

  const progressPercent = clearingState.total > 0
    ? Math.round((clearingState.completed / clearingState.total) * 100)
    : 0;

  return (
    <SettingsScreen title='clear cache'>
      <div className='flex flex-col gap-4'>
        {clearingState.inProgress ? (
          <div className='flex flex-col gap-3'>
            <div className='h-1.5 w-full rounded-full bg-muted overflow-hidden'>
              <div
                className='h-full bg-primary transition-all duration-300 ease-out'
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className='flex justify-between text-xs text-muted-foreground'>
              <span>{getClearCacheStepLabel(clearingState.step)}</span>
              <span>{progressPercent}%</span>
            </div>
            <p className='text-[10px] text-muted-foreground'>
              do not close the extension.
            </p>
          </div>
        ) : (
          <div className='flex flex-col gap-3'>
            <p className='text-sm text-muted-foreground'>
              clears {clearNetwork} sync data and resynchronizes from network.
            </p>
            <p className='flex items-center gap-2 text-xs text-rust'>
              <span className='i-lucide-triangle-alert size-4' />
              your private keys won't be lost
            </p>
          </div>
        )}

        <button
          disabled={clearingState.inProgress}
          onClick={handleCacheClear}
          className='w-full rounded-lg border border-red-500/25 bg-red-500/15 py-2.5 text-sm text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-50'
        >
          {clearingState.inProgress ? 'clearing...' : `clear ${clearNetwork} cache`}
        </button>
      </div>
    </SettingsScreen>
  );
};
