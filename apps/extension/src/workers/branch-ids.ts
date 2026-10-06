/**
 * Consensus branch ids that have the ironwood pool, per network. The ironwood
 * builders bind the endpoint's branch id into the transaction, so a send fails
 * closed unless GetLightdInfo reports one this network has activated:
 *
 * - NU6.3 (0x37a5165b) or NU7 (0x77190ad9), on every network. NU7 activates
 *   by the branch the node reports, as in zcli's NodeParams and Zigner 0.12:
 *   no crate table carries mainnet's NU7 height, and a node that reports a
 *   branch the chain is not on only gets a transaction the network rejects.
 *
 * `GetLightdInfo` returns the id as lowercase hex with no `0x` prefix.
 */
export const NU63_BRANCH_HEX = '37a5165b';
export const NU7_BRANCH_HEX = '77190ad9';

export const ironwoodBranchIds = (_mainnet: boolean): ReadonlySet<string> =>
  new Set([NU63_BRANCH_HEX, NU7_BRANCH_HEX]);

/** undefined when `hex` has the ironwood pool on this network, else why not */
export const ironwoodBranchRefusal = (
  hex: string,
  mainnet: boolean,
  what: string,
): string | undefined =>
  ironwoodBranchIds(mainnet).has(hex)
    ? undefined
    : `endpoint consensus branch id 0x${hex} has no ironwood pool on ${
        mainnet ? 'mainnet' : 'testnet'
      } (expected NU6.3 0x37a5165b or NU7 0x77190ad9); refusing to build ${what}`;
