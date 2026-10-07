import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { PopupPath } from '../paths';
import { BUY_PRELOAD, openBuyPage } from '../../../buy/open';

/**
 * receive / buy / swap / send under the balance (buy where the network can
 * be bought with cash: zcash). A viewing key can never sign, so
 * it gets receive and a quiet "watching" slot instead of dead buttons; an
 * empty wallet keeps receive and swap (swapping into zec needs none) and
 * greys send.
 */
// no side padding: four centred flex-1 buttons fit a 360px side panel only without it
const ACTION = 'h-11 flex-1 gap-1 px-0 text-[13px]';

export const HomeActions = ({
  spendable = true,
  icons = true,
  buy = false,
}: {
  spendable?: boolean;
  /** buy zec with cash, beside receive (opens buy.html) */
  buy?: boolean;
  /** the boards differ: Main draws icons, HomePenumbra plain words */
  icons?: boolean;
}) => {
  const navigate = useNavigate();
  const viewOnly = useStore(
    s => selectEffectiveKeyInfo(s)?.insensitive['coldSignerType'] === 'viewing-key',
  );
  const receive = (
    <Button
      variant='secondary'
      className={ACTION}
      data-preload={PopupPath.RECEIVE}
      onClick={() => navigate(PopupPath.RECEIVE)}
    >
      {icons && <span className='i-lucide-arrow-down size-[15px]' />}
      receive
    </Button>
  );
  if (viewOnly) {
    return (
      <div className='flex gap-2'>
        {receive}
        <span className='flex h-12 flex-1 items-center gap-2 border border-dashed border-surface-border px-3 text-xs text-fg-muted'>
          <span className='i-ph-eye size-3.5 shrink-0' />
          watching · add a signer to send
        </span>
      </div>
    );
  }
  return (
    <div className='flex gap-2'>
      {receive}
      {buy && (
        <Button
          variant='secondary'
          className={ACTION}
          data-preload={BUY_PRELOAD}
          onClick={openBuyPage}
        >
          {icons && <span className='i-lucide-plus size-[15px]' />}
          buy
        </Button>
      )}
      <Button
        variant='secondary'
        className={ACTION}
        data-preload={PopupPath.SWAP}
        onClick={() => navigate(PopupPath.SWAP)}
      >
        {icons && <span className='i-lucide-arrow-left-right size-[15px]' />}
        swap
      </Button>
      <Button
        variant={spendable ? 'primary' : 'secondary'}
        className={ACTION}
        disabled={!spendable}
        data-preload={PopupPath.SEND}
        onClick={() => navigate(PopupPath.SEND)}
      >
        {icons && spendable && <span className='i-lucide-arrow-up size-[15px]' />}
        send
      </Button>
    </div>
  );
};
