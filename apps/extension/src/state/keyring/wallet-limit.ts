/**
 * At most two wallets hold each network, whatever holds the keys: a phrase,
 * a cold signer or a viewing key. A wallet holding both networks counts for
 * both. A shared (frost) wallet and a hidden app table are not counted.
 * Accounts inside one wallet are not wallets, and never count.
 */

export const WALLETS_PER_NETWORK = 2;

const LIMITED = ['zcash', 'penumbra'] as const;

interface VaultFacts {
  readonly type: string;
  readonly insensitive: Record<string, unknown>;
}

/** no supportedNetworks means every network (a phrase wallet) */
export const holdsNetwork = (v: VaultFacts, network: string): boolean => {
  const supported = v.insensitive['supportedNetworks'] as string[] | undefined;
  return !supported || supported.includes(network);
};

/** the networks among `adding` that already have their two wallets */
export const fullNetworks = (vaults: readonly VaultFacts[], adding: readonly string[]): string[] =>
  LIMITED.filter(
    n =>
      adding.includes(n) &&
      vaults.filter(
        v => v.type !== 'frost-multisig' && v.insensitive['hidden'] !== true && holdsNetwork(v, n),
      ).length >= WALLETS_PER_NETWORK,
  );

export const walletLimitLine = (full: readonly string[]): string =>
  `zafu holds up to two ${full.join(' and ')} wallets · please remove one to add another`;

/** refuses a wallet for `adding` that would be a network's third */
export const assertWalletRoom = (vaults: readonly VaultFacts[], adding: readonly string[]) => {
  const full = fullNetworks(vaults, adding);
  if (full.length) {
    throw new Error(walletLimitLine(full));
  }
};

/** a phrase wallet holds every network */
export const PHRASE_NETWORKS: readonly string[] = LIMITED;
