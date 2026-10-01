import { useState } from 'react';
import { ScreenHeader } from '../../../components/screen-header';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { PopupPath } from '../paths';
import { HistoryContent } from './history';

type Filter = 'all' | 'sent' | 'received';

export const ActivityPage = () => {
  const network = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const historyOn = useStore(s => s.privacy.settings.enableTransactionHistory);
  const [filter, setFilter] = useState<Filter>('all');
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='activity' backPath={PopupPath.INDEX} />
      <div className='flex flex-col gap-3 px-4 py-4'>
        {historyOn ? (
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              label='filter activity'
              options={[
                { value: 'all', label: 'all' },
                { value: 'sent', label: 'sent' },
                { value: 'received', label: 'received' },
              ]}
            />
            <HistoryContent network={network} penumbraAccount={penumbraAccount} filter={filter} />
            <span className='text-label text-fg-dim lowercase'>kept only on this computer</span>
          </>
        ) : (
          <span className='text-xs text-fg-muted'>
            history stays off · change it in settings › privacy
          </span>
        )}
      </div>
    </div>
  );
};
