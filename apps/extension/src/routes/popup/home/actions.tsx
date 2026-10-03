import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { PopupPath } from '../paths';

/**
 * receive / swap / send under the balance. A viewing key can never sign, so
 * it gets receive and a quiet "watching" slot instead of dead buttons; an
 * empty wallet keeps receive and swap (swapping into zec needs none) and
 * greys send.
 */
export const HomeActions = ({
  spendable = true,
  icons = true,
}: {
  spendable?: boolean;
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
      className='h-11 flex-1 text-[13px]'
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
      <Button
        variant='secondary'
        className='h-11 flex-1 text-[13px]'
        onClick={() => navigate(PopupPath.SWAP)}
      >
        {icons && <span className='i-lucide-arrow-left-right size-[15px]' />}
        swap
      </Button>
      <Button
        variant={spendable ? 'primary' : 'secondary'}
        className='h-11 flex-1 text-[13px]'
        disabled={!spendable}
        onClick={() => navigate(PopupPath.SEND)}
      >
        {icons && spendable && <span className='i-lucide-arrow-up size-[15px]' />}
        send
      </Button>
    </div>
  );
};
