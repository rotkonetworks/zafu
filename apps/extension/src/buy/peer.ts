/**
 * Peer, from the buy page. Quotes are one plain request (no SDK, so the amount
 * screen is quick); reserving, the verifier and the release load @zkp2p/sdk,
 * which only this page ever imports.
 */

import type { PrivateKeyAccount } from 'viem/accounts';
import { http } from 'viem';
import { BASE_CHAIN_ID, BASE_RPC, BASE_USDC, PEER_API, PEER_ATTESTATION } from '../config/ramps';
import { byBest, toOffer, zafuReferral, type Offer, type PeerQuoteRow } from './fees';
import { baseReader, baseWriter } from './base-chain';

/** Peer's current escrow (EscrowV2), the only one the sdk signals on */
const ESCROW_V2 = '0x777777779d229cdF3110e9de47943791c26300Ef';

export type Quotes =
  | { kind: 'offers'; offers: Offer[]; at: number }
  /** no single seller can fill this much; `max` is the largest that can, in fiat units */
  | { kind: 'limit'; max: bigint; at: number }
  | { kind: 'none'; at: number }
  | { kind: 'unsupported'; at: number };

/** the best sellers on `platform` for exactly `fiat`, best first */
export const fetchQuotes = async (q: {
  platform: string;
  currency: string;
  fiat: bigint;
  address: `0x${string}`;
  signal?: AbortSignal;
}): Promise<Quotes> => {
  const referral = zafuReferral();
  const resp = await fetch(`${PEER_API}/v3/quote/exact-fiat?quotesToReturn=5`, {
    method: 'POST',
    signal: q.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      paymentPlatforms: [q.platform],
      fiatCurrency: q.currency.toUpperCase(),
      user: q.address,
      recipient: q.address,
      destinationChainId: BASE_CHAIN_ID,
      destinationToken: BASE_USDC,
      exactFiatAmount: q.fiat.toString(),
      escrowAddresses: [ESCROW_V2],
      includeNearbyQuotes: true,
      nearbyQuotesCount: 1,
      ...(referral ? { referralFees: [referral] } : {}),
    }),
  });
  const at = Date.now();
  const body = (await resp.json().catch(() => ({}))) as {
    message?: string;
    responseObject?: {
      quotes?: PeerQuoteRow[];
      nearbySuggestions?: { below?: { suggestedFiatAmount?: string }[] };
    };
  };
  if (/unsupported currency/i.test(body.message ?? '')) {
    return { kind: 'unsupported', at };
  }
  const quotes = body.responseObject?.quotes ?? [];
  if (quotes.length) {
    return { kind: 'offers', offers: quotes.map(toOffer).sort(byBest), at };
  }
  const below = body.responseObject?.nearbySuggestions?.below?.[0]?.suggestedFiatAmount;
  return below && /^\d+$/.test(below) && BigInt(below) < q.fiat
    ? { kind: 'limit', max: BigInt(below), at }
    : { kind: 'none', at };
};

const sdk = () => import(/* webpackChunkName: "peer-sdk" */ '@zkp2p/sdk');

/** warm the sdk chunk while the person is still choosing (no network) */
export const preloadPeerSdk = (): void => void sdk();

/** a signing client for the person's key, or a read-only one for their address */
const clientFor = async (account: PrivateKeyAccount | `0x${string}`) => {
  const { Zkp2pClient } = await sdk();
  return new Zkp2pClient({
    walletClient: baseWriter(account),
    chainId: BASE_CHAIN_ID,
    rpcTransport: http(BASE_RPC),
    baseApiUrl: PEER_API,
  });
};

/** the seller's usdc, held for the person: signalIntent from their own key */
export const reserve = async (
  account: PrivateKeyAccount,
  o: Offer,
  onSent?: () => void,
): Promise<{ tx: `0x${string}`; intentHash: `0x${string}`; expiresAt: number }> => {
  const client = await clientFor(account);
  const referral = zafuReferral();
  const tx = await client.signalIntent({
    depositId: o.depositId,
    amount: o.gross,
    toAddress: account.address,
    processorName: o.platform,
    payeeDetails: o.payeeDetails,
    fiatCurrencyCode: o.fiatCurrencyHash,
    conversionRate: o.rate,
    escrowAddress: o.escrow,
    ...(referral ? { referrerFeeConfig: referral } : {}),
  });
  onSent?.();
  await baseReader().waitForTransactionReceipt({ hash: tx });
  const held = await heldIntent(account.address, o.depositId);
  if (!held) {
    throw new Error('the seller was not held');
  }
  return { tx, ...held };
};

/** the person's open intent on a deposit, with its real expiry */
export const heldIntent = async (
  owner: `0x${string}`,
  depositId: string,
): Promise<{ intentHash: `0x${string}`; expiresAt: number } | undefined> => {
  const views = await (await clientFor(owner)).getAccountIntents(owner);
  const v = views.find(i => i.intent.depositId.toString() === depositId);
  return v
    ? {
        intentHash: v.intentHash as `0x${string}`,
        expiresAt: Number(v.intent.timestamp) * 1000 + 6 * 60 * 60 * 1000,
      }
    : undefined;
};

/** give the seller's usdc back before paying (the person's own key) */
export const cancel = async (
  account: PrivateKeyAccount,
  intentHash: `0x${string}`,
): Promise<void> => {
  const hash = await (await clientFor(account)).cancelIntent({ intentHash });
  await baseReader().waitForTransactionReceipt({ hash });
};

/** is this intent still held for the person? */
export const intentHeld = async (owner: `0x${string}`, intentHash: string): Promise<boolean> => {
  const views = await (await clientFor(owner)).getAccountIntents(owner);
  return views.some(v => v.intentHash.toLowerCase() === intentHash.toLowerCase());
};

/** seal the captured session to Peer's verifier enclave (pinned PCRs in the sdk) */
export const sealForVerifier = async (p: {
  platform: string;
  actionType: string;
  sessionMaterial: Record<string, string>;
}): Promise<string> => {
  const { createEncryptedBuyerTeeSessionMaterial } = await sdk();
  return createEncryptedBuyerTeeSessionMaterial({
    ...p,
    attestationServiceUrl: PEER_ATTESTATION,
    attestationServiceFallbackUrls: [],
  });
};

export type ReleaseStep = 'checking' | 'checked' | 'sent' | 'mined';

/** the verifier checks the payment; the person's key releases the usdc to them */
export const release = async (
  account: PrivateKeyAccount,
  p: {
    intentHash: `0x${string}`;
    encryptedSessionMaterial: string;
    params: Record<string, string | number>;
    platform: string;
    actionType: string;
  },
  onStep: (s: ReleaseStep) => void,
): Promise<`0x${string}`> => {
  const client = await clientFor(account);
  return client.fulfillIntent({
    intentHash: p.intentHash,
    proof: {
      proofType: 'buyerTee',
      encryptedSessionMaterial: p.encryptedSessionMaterial,
      params: p.params,
      actionPlatform: p.platform,
      actionType: p.actionType,
    },
    attestationServiceUrl: PEER_ATTESTATION,
    attestationServiceFallbackUrls: [],
    callbacks: {
      onAttestationStart: () => onStep('checking'),
      onAttestationComplete: () => onStep('checked'),
      onTxSent: () => onStep('sent'),
      onTxMined: () => onStep('mined'),
    },
  });
};
