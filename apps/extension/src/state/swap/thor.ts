/** THORChain as a swap route; its zcash client is transparent only, both ways. zafu's fee is its affiliate */

import { THOR_AFFILIATE } from '../../config/swap-fee';
import { THORNODE_URLS } from '../../services/thornode';
import { nodeProvider } from './thornode';

export const thorProvider = nodeProvider({
  id: 'thor',
  prefix: '/thorchain',
  urls: THORNODE_URLS,
  affiliate: THOR_AFFILIATE,
});
