import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { PopupPath } from '../paths';
import { HistoryContent } from './history';

export const ActivityPage = () => {
  const network = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const historyOn = useStore(s => s.privacy.settings.enableTransactionHistory);
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='activity' backPath={PopupPath.INDEX} />
      <div className='flex flex-col px-4 py-4'>
        {historyOn ? (
          <HistoryContent network={network} penumbraAccount={penumbraAccount} />
        ) : (
          <span className='text-xs text-fg-muted'>
            history stays off · change it in settings › privacy
          </span>
        )}
      </div>
    </div>
  );
};
