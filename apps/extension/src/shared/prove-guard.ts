/**
 * The offscreen prover's contract: the functions it runs, and that no request
 * to it carries a recovery phrase, seed or private key. Hot sends are proven
 * from the account's UFVK and signed in the zcash worker, so nothing on the
 * prover relay (page, service worker, offscreen document) needs key material.
 * The zcash worker checks before it posts, the offscreen handler on arrival.
 */
export const PROVER_FNS = [
  'build_unsigned',
  'build_unsigned_pczt',
  'build_turnstile_migration_pczt',
  'build_ironwood_send_pczt',
  'build_unsigned_shielding',
  'build_unsigned_shielding_ironwood',
  // shielded voting, on the standalone voting-wasm module
  'build_delegation_pczt',
  'finalize_delegation',
  'cast_vote_hot_wire',
] as const;

export type ProverFn = (typeof PROVER_FNS)[number];

export interface ProveRequest {
  fn: ProverFn;
  args: unknown[];
}

const SECRET_KEYS = new Set([
  'mnemonic',
  'seed',
  'seedphrase',
  'seed_phrase',
  'phrase',
  'privkey',
  'privkeyhex',
  'privkey_hex',
  'privatekey',
  'private_key',
  'spendingkey',
  'spending_key',
  'vault',
]);

/** 12 to 24 lowercase words: a BIP39 phrase passed as a bare argument */
const PHRASE = /^[a-z]+(?: [a-z]+){11,23}$/;

const carriesSecret = (v: unknown, depth = 0): boolean => {
  if (typeof v === 'string') {
    return PHRASE.test(v.trim());
  }
  if (!v || typeof v !== 'object' || depth > 8) {
    return false;
  }
  if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) {
    return true;
  }
  return Object.entries(v).some(
    ([k, x]) => SECRET_KEYS.has(k.toLowerCase()) || carriesSecret(x, depth + 1),
  );
};

/** the request, if it names a prover function and carries no key material; throws otherwise */
export const assertProveRequest = (req: unknown): ProveRequest => {
  const r = req as Partial<ProveRequest> | null;
  if (!r || !PROVER_FNS.includes(r.fn!) || !Array.isArray(r.args)) {
    throw new Error(`the prover does not run ${String(r?.fn)}`);
  }
  if (carriesSecret(r.args)) {
    throw new Error(`refusing ${r.fn}: the request carries key material`);
  }
  return r as ProveRequest;
};
