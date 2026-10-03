/** THORChain as a swap route; its zcash client is transparent only, both ways */

import { THORNODE_URLS } from '../../services/thornode';
import { nodeProvider } from './thornode';

export const thorProvider = nodeProvider({
  id: 'thor',
  prefix: '/thorchain',
  urls: THORNODE_URLS,
  refundInMemo: true,
});
