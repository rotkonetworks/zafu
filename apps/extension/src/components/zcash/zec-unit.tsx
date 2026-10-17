import { useStore } from '../../state';
import { selectZcashUnit } from '../../state/wallets';

/** the gold unit after a large amount: zec, or taz on testnet */
export const ZecUnit = () => (
  <span className='text-sm text-zigner-gold'>{useStore(selectZcashUnit)}</span>
);
