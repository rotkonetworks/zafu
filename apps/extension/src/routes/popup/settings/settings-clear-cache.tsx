import { ExclamationTriangleIcon } from '@radix-ui/react-icons';
import { Button } from '@repo/ui/components/ui/button';
import { TrashGradientIcon } from '../../../icons/trash-gradient';
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

  // Check if clearing was interrupted on mount
  useEffect(() => {
    void localExtStorage.get('clearingCache').then(wasClearing => {
      if (wasClearing) {
        // Previous clear was interrupted - resume display
        setClearingState({
          inProgress: true,
          step: 'clearing-database',
          completed: 2,
          total: CLEAR_CACHE_STEPS.length,
        });
        // Trigger another clear to complete the operation
        void chrome.runtime.sendMessage(ServicesMessage.ClearCache);
      }
    });
  }, []);

  // Listen for progress updates
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
    <SettingsScreen title='Clear Cache' IconComponent={TrashGradientIcon}>
      <div className='flex flex-1 flex-col items-start justify-between px-[30px] pb-5'>
        {clearingState.inProgress ? (
          // Progress view
          <div className='flex flex-col items-center gap-4 w-full'>
            <p className='font-headline text-base font-semibold'>Clearing Cache</p>

            {/* Progress bar */}
            <div className='w-full'>
              <div className='h-2 w-full rounded-full bg-secondary overflow-hidden'>
                <div
                  className='h-full bg-gradient-to-r from-teal-400 to-teal-600 transition-all duration-300 ease-out'
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className='flex justify-between mt-2'>
                <p className='text-sm text-muted-foreground'>
                  {getClearCacheStepLabel(clearingState.step)}
                </p>
                <p className='text-sm text-muted-foreground'>
                  {progressPercent}%
                </p>
              </div>
            </div>

            <p className='text-xs text-muted-foreground text-center mt-2'>
              Please wait. Do not close the extension.
            </p>
          </div>
        ) : (
          // Confirmation view
          <div className='flex flex-col items-center gap-2'>
            <p className='font-headline text-base font-semibold'>Are you sure?</p>
            <p className='text-center text-muted-foreground'>
              Do you really want to clear cache? All local data will be deleted and resynchronized.
            </p>
            <p className='mt-2 flex items-center gap-2 font-headline text-base font-semibold text-rust'>
              <ExclamationTriangleIcon className='size-[30px] text-rust' /> Your private keys won't be
              lost!
            </p>
          </div>
        )}

        <Button
          disabled={clearingState.inProgress}
          variant='gradient'
          size='lg'
          className='w-full'
          onClick={handleCacheClear}
        >
          {clearingState.inProgress ? 'Clearing...' : 'Confirm'}
        </Button>
      </div>
    </SettingsScreen>
  );
};
