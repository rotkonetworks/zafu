import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpIcon, ArrowDownIcon, CopyIcon, CheckIcon } from '@radix-ui/react-icons';

import { useStore } from '../../../state';
import { keyRingSelector } from '../../../state/keyring';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { IndexHeader } from './index-header';
import { AssetsTable } from './assets-table';

export interface PopupLoaderData {
  fullSyncHeight?: number;
}

export const popupIndexLoader = async (): Promise<Response | PopupLoaderData> => {
  await needsOnboard();
  const redirect = await needsLogin();
  if (redirect) return redirect;
  return { fullSyncHeight: await localExtStorage.get('fullSyncHeight') };
};

export const PopupIndex = () => {
  const { selectedKeyInfo } = useStore(keyRingSelector);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  // Dismiss backup reminder on first load if not seen
  useEffect(() => {
    void localExtStorage.get('backupReminderSeen').then(seen => {
      if (seen === false) void localExtStorage.set('backupReminderSeen', true);
    });
  }, []);

  const copyAddress = useCallback(async () => {
    if (!selectedKeyInfo) return;
    // TODO: derive address from mnemonic for selected network
    await navigator.clipboard.writeText('address-placeholder');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [selectedKeyInfo]);

  // TODO: derive actual address per network
  const shortAddr = selectedKeyInfo ? `${selectedKeyInfo.name}` : 'No wallet';

  return (
    <div className='flex min-h-full flex-col'>
      <IndexHeader />

      <div className='flex flex-col gap-3 p-4'>
        {/* Balance + Actions Row */}
        <div className='flex items-center justify-between rounded-xl border border-border/40 bg-card p-4'>
          <div>
            <div className='text-xs text-muted-foreground'>Balance</div>
            <div className='text-2xl font-semibold tabular-nums text-foreground'>$0.00</div>
            <button
              onClick={copyAddress}
              className='mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-100 hover:text-foreground'
            >
              <span className='font-mono'>{shortAddr}</span>
              {copied ? <CheckIcon className='h-3 w-3' /> : <CopyIcon className='h-3 w-3' />}
            </button>
          </div>

          <div className='flex gap-2'>
            <button
              onClick={() => navigate(PopupPath.RECEIVE)}
              className='flex h-10 w-10 items-center justify-center rounded-lg bg-muted transition-all duration-100 hover:bg-muted/80 active:scale-95'
              title='Receive'
            >
              <ArrowDownIcon className='h-5 w-5' />
            </button>
            <button
              onClick={() => navigate(PopupPath.SEND)}
              className='flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95'
              title='Send'
            >
              <ArrowUpIcon className='h-5 w-5' />
            </button>
          </div>
        </div>

        {/* Assets */}
        <div className='flex-1'>
          <div className='mb-2 text-xs font-medium text-muted-foreground'>Assets</div>
          <AssetsTable account={0} />
        </div>
      </div>
    </div>
  );
};
