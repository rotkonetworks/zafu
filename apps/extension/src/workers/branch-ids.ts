/**
 * Consensus branch ids that have the ironwood pool, per network. The ironwood
 * builders bind the endpoint's branch id into the transaction, so a send fails
 * closed unless GetLightdInfo reports one this network has activated:
 *
 * - mainnet: NU6.3 (0x37a5165b) only. NU7 has no mainnet height, so a mainnet
 *   node that reports it is misconfigured or lying, and a proof bound to it
 *   would be rejected by the network.
 * - testnet: NU6.3, or NU7 (0x77190ad9) from 4,465,026.
 *
 * `GetLightdInfo` returns the id as lowercase hex with no `0x` prefix.
 */
export const NU63_BRANCH_HEX = '37a5165b';
export const NU7_BRANCH_HEX = '77190ad9';

export const ironwoodBranchIds = (mainnet: boolean): ReadonlySet<string> =>
  new Set(mainnet ? [NU63_BRANCH_HEX] : [NU63_BRANCH_HEX, NU7_BRANCH_HEX]);

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
      } (expected ${
        mainnet ? 'NU6.3 0x37a5165b' : 'NU6.3 0x37a5165b or NU7 0x77190ad9'
      }); refusing to build ${what}`;
