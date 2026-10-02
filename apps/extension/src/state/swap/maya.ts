/**
 * MAYAChain as a swap route, on the THORNode protocol under `/mayachain`.
 * Off while MAYA_ENABLED is false (see config/feature-flags).
 *
 * Maya pays zec to transparent and sapling receivers only: from its 1.131.0
 * (ZIP 2006) it rejects orchard-only unified addresses, and its signer builds
 * no ironwood outputs, so zafu's shielded address can't be paid and zec lands
 * at the pocket's t-address. It can read a memo from a 0-value shielded note
 * beside a transparent vault output, but zafu's builder sends to one recipient,
 * so zec goes in as the same t->t with an OP_RETURN that thorchain takes.
 *
 * Refunds go to whoever paid: naming the refund address in the memo pushes a
 * btc or dash memo past its 80 bytes. Maya resolves MAYANames, not THORNames.
 */

import { nodeProvider } from './thornode';

export const mayaProvider = nodeProvider({
  id: 'maya',
  prefix: '/mayachain',
  urls: ['https://mayanode.mayachain.info'],
  refundInMemo: false,
  thorNames: false,
});
