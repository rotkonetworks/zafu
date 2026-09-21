/**
 * Canonical bytes an ed25519 ZID identity signs to AUTHENTICATE a post-quantum
 * sealed-box prekey (`pq_pubkey`).
 *
 * The wallet (signer) and the dapp SDK (verifier) both build the signed message
 * from THIS one function, so the two can never disagree on the encoding. A
 * `pq_pubkey` swapped in the key-distribution channel then fails verification -
 * closing the gap that the unsigned prekey used to leave open (Signal's PQXDH
 * signs its PQ prekey with the identity key; this is the analog).
 *
 * The message binds:
 *  - a version/domain tag (so these bytes can't be repurposed),
 *  - the suite (e.g. 'xwing-v1'),
 *  - the origin the key was derived for,
 *  - the rotation epoch the key belongs to (so a signature can't be replayed
 *    for a different epoch's key), and
 *  - the raw pq_pubkey bytes.
 *
 * Fields are length-prefixed (4-byte big-endian length each) so the
 * concatenation is unambiguous - no separator-injection across fields.
 */
export const PQ_KEY_AUTH_DOMAIN = 'zafu-pq-key-auth-v1';

export function pqKeyAuthMessage(
  suite: string,
  origin: string,
  epoch: number,
  pqPubkey: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const parts = [
    enc.encode(PQ_KEY_AUTH_DOMAIN),
    enc.encode(suite),
    enc.encode(origin),
    enc.encode(String(epoch)),
    pqPubkey,
  ];
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    dv.setUint32(o, p.length, false);
    o += 4;
    out.set(p, o);
    o += p.length;
  }
  return out;
}
