import {
  ServicesMessage,
  getClearCacheStepLabel,
  CLEAR_CACHE_STEPS,
  type ClearCacheProgress,
  type ClearCacheStep,
} from '../../../message/services';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
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
  const [clearingState, setClearingState] = useState<ClearingState>({
    inProgress: false,
    step: 'stopping',
    completed: 0,
    total: CLEAR_CACHE_STEPS.length,
  });

  useEffect(() => {
    void localExtStorage.get('clearingCache').then(wasClearing => {
      if (wasClearing) {
        setClearingState({
          inProgress: true,
          step: 'clearing-database',
          completed: 2,
          total: CLEAR_CACHE_STEPS.length,
        });
        void chrome.runtime.sendMessage(ServicesMessage.ClearCache);
      }
    });
  }, []);

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
      await chrome.runtime.sendMessage(ServicesMessage.ClearCache);
      useStore.setState(state => {
        state.network.fullSyncHeight = undefined;
      });
      navigate(PopupPath.INDEX);
    })();
  };

  return { handleCacheClear, clearingState };
};

export const SettingsClearCache = () => {
  const { handleCacheClear, clearingState } = useCacheClear();

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
              all local data will be deleted and resynchronized.
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
          {clearingState.inProgress ? 'clearing...' : 'clear cache'}
        </button>
      </div>
    </SettingsScreen>
  );
};
