/**
 * zafu's gas sponsor for Base. A fresh Base address holds no eth, and
 * signalIntent must come from it. The page asks the sponsor for a few cents
 * of eth; with no sponsor (none deployed, unreachable, said no) the person
 * sees their address and sends a little themselves.
 *
 * Contract (server not in this repo):
 *   POST https://sponsor.zafu.pro/base/gas
 *   { address: "0x..", intent: { depositId, amount, platform, currency } }
 *   200 { txHash: "0x..", wei: "1500000000000" }   drip sent
 *   409 { error: "funded" }                         enough eth already
 *   429 { error: "rate", retryAfter: <s> }          one drip per address per day
 *   4xx/5xx otherwise                               no sponsor for this one
 */

import { BASE_GAS_SPONSOR } from '../config/ramps';
import type { Offer } from './fees';

export type Drip = { ok: true; txHash?: `0x${string}` } | { ok: false };

export const askForGas = async (
  address: `0x${string}`,
  o: Offer,
  currency: string,
): Promise<Drip> => {
  try {
    const r = await fetch(BASE_GAS_SPONSOR, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address,
        intent: {
          depositId: o.depositId,
          amount: o.gross.toString(),
          platform: o.platform,
          currency,
        },
      }),
    });
    if (r.status === 409) {
      return { ok: true };
    }
    if (!r.ok) {
      return { ok: false };
    }
    const body = (await r.json().catch(() => ({}))) as { txHash?: string };
    return {
      ok: true,
      txHash: /^0x[0-9a-f]{64}$/i.test(body.txHash ?? '')
        ? (body.txHash as `0x${string}`)
        : undefined,
    };
  } catch {
    return { ok: false };
  }
};
