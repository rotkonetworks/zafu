/** Hyperliquid's fixed facts, apart from the code so the egress policy reads them alone */

export const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';

/**
 * The bridge on Arbitrum that credits USDC sent to it, and the least it
 * credits (docs: for developers > api > bridge2). Less than this is lost.
 */
export const HYPERLIQUID_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
export const HYPERLIQUID_MIN_DEPOSIT = 5_000_000n;
/** what Hyperliquid keeps from a withdrawal (docs: exchange endpoint, withdraw3) */
export const HYPERLIQUID_WITHDRAW_FEE = 1_000_000n;

/** Unit (hyperunit) bridges native ZEC to Hyperliquid's spot token UZEC, one for one */
export const UNIT_API = 'https://api.hyperunit.xyz';
/** the least Unit processes, either way (docs.hyperunit.xyz: supported assets, 2026-11-16) */
export const UNIT_MIN_ZEC = 7_000_000n;
