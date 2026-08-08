/**
 * zcash send transaction flow with zigner signing
 *
 * steps:
 * 1. enter recipient and amount
 * 2. review transaction details
 * 3. display sign request qr for zigner
 * 4. scan signature qr from zigner
 * 5. broadcast transaction
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Sensitive } from '../../../components/sensitive';
import { useStore } from '../../../state';
import { zignerSigningSelector } from '../../../state/zigner-signing';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { messagesSelector } from '../../../state/messages';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import {
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  completeSendTxInWorker,
  completeOrchardPcztInWorker,
  completeSendTxPcztInWorker,
  getBalanceInWorker,
  getFeeMultiplier,
  type SendTxUnsignedResult,
  type SendTxPcztUnsignedResult,
} from '../../../state/keyring/network-worker';
import { usePoolNotes } from '../../../hooks/zcash-pool-balances';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { nu63ActivationHeight } from '../../../config/feature-flags';
import { maxSendable, quoteSend } from './spendable';
import { Button } from '@repo/ui/components/ui/button';
import { HankoSeal } from '@repo/ui/components/editorial';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { FrostAirgapSignFlow, runMnemonicFrostSign } from './frost-multisig';
import { DontQuitIcon } from './frost-multisig/helpers';
import { RecipientPicker } from '../../../components/recipient-picker';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { usePasswordGate } from '../../../hooks/password-gate';
import { HARDWARE_WALLET_ENABLED } from '../../../config/feature-flags';
// connectLedger pairs/opens a WebHID session; ledgerSignerFor wraps the
// PCZT-signing service in the feature-flag + app-version gates.
import { connectLedger } from '../../../ledger';
import { ledgerSignerFor } from '../../../signing/ledger-signer';
import { isPopup } from '../../../utils/popup-detection';
import { isZcashSignatureQR, parseZcashSignatureResponse, bytesToHex } from '@repo/wallet/networks'; // self-contained 4-step zigner-mediated multisig sign

import { unwrapCborSinglePczt, parsePreludeSinglePcztResponse } from './zcash-send-cbor-helpers';
import {
  parseCompactResponse,
  mergeContributions,
  SUPPORTED_COMPACT_RESPONSE_VERSION,
} from '../../../state/keyring/compact-signing';

interface ZcashSendProps {
  onClose: () => void;
  accountIndex: number;
  mainnet: boolean;
  /** pre-filled values from inbox compose */
  prefill?: {
    recipient?: string;
    amount?: string;
    memo?: string;
  };
}

type SendStep =
  | 'form'
  | 'review'
  | 'building'
  | 'sign'
  | 'scan'
  | 'broadcast'
  | 'complete'
  | 'error'
  | 'ledger-sign'
  | 'frost-room'
  | 'frost-signing'
  | 'airgap-flow';

/** zatoshi → ZEC, trailing zeros trimmed. Matches the formatting used inline. */
const fmtZecShort = (zat: bigint): string =>
  (Number(zat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

/** live elapsed timer — ticks every second so the build screen never looks frozen */
function LiveTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startMs) {
      return;
    }
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return <div className='font-mono text-2xl tabular-nums text-zigner-gold'>{elapsed}s</div>;
}

export function ZcashSend({ onClose, accountIndex, mainnet, prefill }: ZcashSendProps) {
  const {
    txHash,
    error: signingError,
    startSigning,
    startScanning,
    processSignature,
    complete,
    setError,
    reset,
  } = useStore(zignerSigningSelector);

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave, dismissSuggestion } = useStore(recentAddressesSelector);
  const { findByAddress } = useStore(contactsSelector);
  const messages = useStore(messagesSelector);
  // tempTxId for the optimistic outgoing record created on send-click;
  // promoted to the real txid once the build step returns one.
  const pendingTempTxIdRef = useRef<string | null>(null);

  /** promote the optimistic record to the real txid and mark it broadcasted. */
  const promoteToBroadcasted = useCallback(
    async (realTxId: string) => {
      const tempId = pendingTempTxIdRef.current;
      if (tempId) {
        try {
          await messages.promoteOutgoing(tempId, realTxId);
        } catch (e) {
          console.warn(e);
        }
        pendingTempTxIdRef.current = null;
      }
      try {
        await messages.markOutgoingBroadcast(realTxId);
      } catch (e) {
        console.warn(e);
      }
    },
    [messages],
  );

  /** mark the optimistic record failed if one is still pending. */
  const markPendingFailed = useCallback(
    async (reason: string) => {
      const tempId = pendingTempTxIdRef.current;
      if (!tempId) {
        return;
      }
      try {
        await messages.markOutgoingFailed(tempId, reason);
      } catch (e) {
        console.warn(e);
      }
      pendingTempTxIdRef.current = null;
    },
    [messages],
  );

  // The store object, captured once. `messages` is an immer slice: EVERY
  // mutation anywhere in the slice replaces it, so depending on it in the
  // unmount effect below re-ran that cleanup on unrelated store churn — an
  // incoming message arriving during a 30s–2min halo2 prove was enough to
  // stamp the live send as over. The actions on the slice are stable, so a ref
  // is the honest way to say "I want the store, not a subscription to it".
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Unmount cleanup. A chrome popup unmounts on any click-outside, and the
  // build/prove/broadcast pipeline it started keeps running, so this CANNOT
  // report failure: we simply stop being able to observe the outcome.
  //
  // 'interrupted' says exactly that. It also leaves the record promotable —
  // the ref is deliberately NOT cleared, so if this unmount was a navigation
  // inside a surviving document (tab / side panel) the in-flight
  // promoteToBroadcasted() still rewrites the temp id to the real txid and
  // moves it on to broadcasting → pending.
  //
  // Empty deps: this must run on real unmount and nothing else.
  useEffect(() => {
    return () => {
      const tempId = pendingTempTxIdRef.current;
      if (tempId !== null) {
        void messagesRef.current.markOutgoingInterrupted(
          tempId,
          'zafu closed while this send was still in progress — it may still have been sent',
        );
      }
    };
  }, []);

  const [step, setStep] = useState<SendStep>('form');
  const [recipient, setRecipient] = useState(prefill?.recipient ?? '');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [memo, setMemo] = useState(prefill?.memo ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  // legacy single-QR signing path (kept for non-PCZT consumers); the PCZT
  // path uses pcztSignFrames + AnimatedQrDisplay below. Once every flow is
  // migrated to PCZT we can drop this entirely.
  const [signRequestQr] = useState<string | null>(null);
  // PCZT-mode sign request (zigner single-signer). When set, the sign step
  // shows AnimatedQrDisplay instead of the legacy single QR, and the scan
  // step uses AnimatedQrScanner with `ur:zcash-pczt` filter.
  const [pcztSignFrames, setPcztSignFrames] = useState<string[] | null>(null);
  // The signed PCZT returns under the SAME UR type the unsigned display frames
  // carry: orchard uses `zcash-pczt`; an ironwood (NU6.3) send uses the
  // zigner-module prelude envelope. Derive the signed-scan filter from the
  // display frames so the return leg matches for both pools (default orchard).
  const [pcztSignedUrType, setPcztSignedUrType] = useState<string>('zcash-pczt');
  const pcztUnsignedRef = useRef<SendTxPcztUnsignedResult | null>(null);
  // Binds the response format handlePcztSignatureScanned is allowed to accept
  // to what was actually sent. Today the outgoing PCZT-sign request always
  // rides the legacy `ur:zcash-pczt` CBOR wrap (see `cborWrapPczt` in
  // zcash-worker.ts) — zafu does not yet build a compact (tx_type 0x05/0x06)
  // request via `buildCompactRequest` anywhere in this flow. This stays
  // `false` until that wiring lands; a device offering a compact response
  // (0x07/0x08) while this is `false` is therefore always rejected rather
  // than trusted opportunistically.
  const pcztRequestWasCompactRef = useRef(false);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [fee, setFee] = useState('0.0001');
  const [, setShowContacts] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const unsignedTxRef = useRef<SendTxUnsignedResult | null>(null);
  // airgap FROST multisig now builds a PCZT (gh #17) — separate from the legacy
  // v5 unsignedTxRef so the cold-sign scan fallback path stays untouched.
  const pcztMultisigRef = useRef<SendTxPcztUnsignedResult | null>(null);
  const [sendSteps, setSendSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);
  const [totalElapsedSec, setTotalElapsedSec] = useState<number | null>(null);
  const buildStartRef = useRef(0);

  // self-custody multisig (mnemonic FROST) state
  const [frostRoomCode, setFrostRoomCode] = useState('');
  const [frostProgress, setFrostProgress] = useState('');
  const frostAbortRef = useRef<AbortController | null>(null);

  // store access for wallet id and server url
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const ufvk =
    activeZcashWallet?.ufvk ??
    (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);

  // Ledger send branch is flag-gated (HARDWARE_WALLET_ENABLED) AND keyed off the
  // account actually being a ledger vault. Two shapes can indicate ledger:
  //   - a full ledger keyvault: selectedKeyInfo.type === 'ledger'
  //   - a watch-only import whose cold signer is a ledger. This parallels the
  //     existing zigner-vs-keystone detection: the cold-signer kind is carried
  //     in the KeyInfo `insensitive` metadata bag as `coldSignerType`
  //     ('zigner' | 'keystone' | 'ledger'), NOT on the ZcashWalletJson. Read it
  //     from there (Record<string, unknown>, so compare as string).
  const coldSignerType = selectedKeyInfo?.insensitive?.['coldSignerType'] as string | undefined;
  const isLedgerAccount =
    HARDWARE_WALLET_ENABLED && (selectedKeyInfo?.type === 'ledger' || coldSignerType === 'ledger');

  // ── what this form is allowed to say about your money ───────────────────
  //
  // The figure shown here is the balance of the pool this send will actually
  // spend from, not the wallet total. Post-NU6.3 orchard→orchard sends are
  // consensus-disabled, so orchard funds are real but NOT sendable — a wallet
  // holding 5 ZEC orchard and 0.01 ZEC ironwood used to advertise 5.0099 and
  // then die after a full witness build and a two-minute prove. See
  // ./spendable.ts for the arithmetic and the rest of the reasoning.
  const { chainTip: sendChainTip } = useZcashSyncStatus();
  const sendChainHeight = sendChainTip?.height ?? 0;
  // Unknown height (0) is treated as post-activation: the send worker resolves
  // the pool from the LIVE tip it fetches, and on mainnet today that is
  // ironwood. Guessing orchard here would advertise funds the build refuses.
  const activePool: 'orchard' | 'ironwood' =
    sendChainHeight > 0 && sendChainHeight < nu63ActivationHeight(mainnet) ? 'orchard' : 'ironwood';

  const poolNotes = usePoolNotes(selectedKeyInfo?.id);
  const [feeMultiplier, setFeeMultiplier] = useState(1);
  useEffect(() => {
    getFeeMultiplier()
      .then(setFeeMultiplier)
      .catch(() => {});
  }, []);

  /** unspent note values in the pool this send would spend from */
  const spendableNotes = useMemo(
    () => poolNotes[activePool].filter(n => !n.spent).map(n => BigInt(n.value)),
    [poolNotes, activePool],
  );
  /** value sitting in the pool that CANNOT be spent — orchard, post-NU6.3 */
  const strandedZat = useMemo(
    () =>
      activePool === 'ironwood'
        ? poolNotes.orchard.filter(n => !n.spent).reduce((s, n) => s + BigInt(n.value), 0n)
        : 0n,
    [poolNotes, activePool],
  );

  // Until the first notes fetch resolves we know nothing. `0n` would read as
  // "you have no money", which is the one thing a wallet must not say when it
  // simply has not looked yet.
  const [notesLoaded, setNotesLoaded] = useState(false);
  useEffect(() => {
    if (poolNotes.orchard.length > 0 || poolNotes.ironwood.length > 0) {
      setNotesLoaded(true);
    }
  }, [poolNotes]);
  useEffect(() => {
    if (!selectedKeyInfo) {
      return;
    }
    // resolves even for a wallet with no notes at all, which the length check
    // above cannot distinguish from "not fetched yet"
    getBalanceInWorker('zcash', selectedKeyInfo.id)
      .then(() => setNotesLoaded(true))
      .catch(() => {});
  }, [selectedKeyInfo?.id]);

  const balanceZat = notesLoaded ? spendableNotes.reduce((s, v) => s + v, 0n) : null;

  const recipientIsTransparent = /^(t1|t3|tm|t2)/.test(recipient.trim());
  // The real max: spends every note in the pool, priced with the ZIP-317 fee
  // that transaction would actually pay. Recomputed when the recipient type
  // changes, because a transparent output is priced differently.
  const maxSend = useMemo(
    () =>
      maxSendable(spendableNotes, {
        transparentRecipient: recipientIsTransparent,
        feeMultiplier,
      }),
    [spendableNotes, recipientIsTransparent, feeMultiplier],
  );

  /**
   * Price the amount as typed, the way the worker will price it at build time.
   * `null` when there is nothing to price yet.
   */
  const amountQuote = useMemo(() => {
    const n = Number(amount);
    if (!amount.trim() || isNaN(n) || n <= 0 || !notesLoaded) {
      return null;
    }
    return quoteSend(spendableNotes, BigInt(Math.round(n * 1e8)), {
      transparentRecipient: recipientIsTransparent,
      feeMultiplier,
    });
  }, [amount, spendableNotes, recipientIsTransparent, feeMultiplier, notesLoaded]);

  // Keep the DISPLAYED fee in step with the quote.
  //
  // `fee` was initialised to the literal '0.0001' and only overwritten from the
  // worker's result — which on the hot path arrives AFTER the transaction has
  // been proved and broadcast. So the number on the review screen, the one the
  // user reads before approving an irreversible send, was a constant that had
  // nothing to do with what they would actually pay: the real ZIP-317 fee
  // scales with the input count and the user's fee multiplier, and can be
  // 15,000-25,000+ zat rather than 10,000.
  //
  // quoteSend already prices exactly what the worker will build. Showing that
  // costs nothing and makes the review screen true. The worker's post-build
  // value still overwrites it, so a surprise there can only correct downward
  // into the receipt, never mislead the approval.
  useEffect(() => {
    if (amountQuote?.ok) {
      setFee((Number(amountQuote.feeZat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
    }
  }, [amountQuote]);

  // listen for send progress events from worker
  useEffect(() => {
    if (step !== 'building' && step !== 'broadcast') {
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        step: string;
        detail?: string;
        elapsedMs: number;
      };
      setSendSteps(prev => [...prev, detail]);
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [step]);

  const validateForm = (): boolean => {
    if (!recipient.trim()) {
      setFormError('recipient address is required');
      return false;
    }
    const r = recipient.trim();
    const validPrefix =
      r.startsWith('u1') || r.startsWith('utest1') || r.startsWith('t1') || r.startsWith('t3');
    if (!validPrefix) {
      setFormError(
        'invalid zcash address - expected unified (u1) or transparent (t1/t3). sapling (zs) is not supported.',
      );
      return false;
    }
    if (!amount.trim() || isNaN(Number(amount)) || Number(amount) <= 0) {
      setFormError('enter a valid amount');
      return false;
    }
    // Price it here, not after a witness build and a halo2 prove. The worker
    // applies the same ZIP-317 arithmetic; reaching it with an amount this
    // check rejects means waiting minutes for a raw zatoshi error.
    if (notesLoaded) {
      const quote = quoteSend(spendableNotes, BigInt(Math.round(Number(amount) * 1e8)), {
        transparentRecipient: /^(t1|t3|tm|t2)/.test(r),
        feeMultiplier,
      });
      if (!quote.ok) {
        const maxForThis = maxSendable(spendableNotes, {
          transparentRecipient: /^(t1|t3|tm|t2)/.test(r),
          feeMultiplier,
        });
        setFormError(
          `not enough spendable ${activePool} balance — the most this can send, ` +
            `after a ${fmtZecShort(quote.feeZat)} ZEC fee, is ${fmtZecShort(maxForThis.amountZat)} ZEC` +
            (strandedZat > 0n
              ? `. ${fmtZecShort(strandedZat)} ZEC is held in the legacy orchard pool and cannot ` +
                'be spent until it is migrated to ironwood.'
              : ''),
        );
        return false;
      }
    }
    setFormError(null);
    return true;
  };

  const handleReview = () => {
    if (validateForm()) {
      setStep('review');
    }
  };

  const handleSign = async () => {
    if (!selectedKeyInfo) {
      setFormError('no wallet selected');
      return;
    }

    // Re-entrancy guard: if a previous send is still in flight (we've moved
    // past 'form'/'review' and haven't yet reached 'complete' or 'error'),
    // ignore the click. Without this, a double-tap creates two temp records
    // and the first is orphaned in 'submitting' since pendingTempTxIdRef
    // gets overwritten.
    const inFlight =
      step !== 'form' && step !== 'review' && step !== 'complete' && step !== 'error';
    if (inFlight) {
      console.warn('[zcash-send] handleSign re-entered while step =', step);
      return;
    }

    setStep('building');
    setFormError(null);
    setSendSteps([]);
    buildStartRef.current = Date.now();

    // optimistic outgoing entry — visible in inbox immediately, before
    // any RPC. promoted to the real txid post-build; marked failed in
    // the catch block below if anything throws.
    try {
      const { tempTxId } = await messages.addOutgoingPending({
        network: 'zcash',
        recipientAddress: recipient.trim(),
        content: memo || '',
        amount,
        asset: 'ZEC',
      });
      pendingTempTxIdRef.current = tempTxId;
    } catch (e) {
      console.warn('[zcash-send] failed to record optimistic pending:', e);
      pendingTempTxIdRef.current = null;
    }

    try {
      const walletId = selectedKeyInfo.id;
      const amountZat = Math.round(Number(amount) * 1e8).toString();

      if (selectedKeyInfo.type === 'mnemonic') {
        // mnemonic wallet: verify password, then build signed tx + broadcast
        const authorized = await requestAuth();
        if (!authorized) {
          setStep('review');
          return;
        }
        const mnemonic = await getMnemonic(walletId);
        const result = await buildSendTxInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          accountIndex,
          mainnet,
          mnemonic,
        );

        if ('txid' in result) {
          const feeZec = (Number(result.fee) / 1e8)
            .toFixed(8)
            .replace(/0+$/, '')
            .replace(/\.$/, '');
          setFee(feeZec);
          void promoteToBroadcasted(result.txid);
          complete(result.txid);
          setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
          setStep('complete');
          void recordUsage(recipient, 'zcash');
          if (shouldSuggestSave(recipient)) {
            setShowSavePrompt(true);
          }
        }
      } else if (activeZcashWallet?.multisig?.custody === 'airgapSigner') {
        // airgap multisig: build a PCZT (gh #17) then hand off to FrostAirgapSignFlow.
        if (!ufvk) {
          throw new Error('UFVK required for airgap multisig PCZT build');
        }
        // frost=true: the worker fails closed post-NU6.3 rather than return an
        // ironwood PCZT with empty sighash/alphas that no co-signer can sign.
        const result = await buildSendTxPcztInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          0,
          mainnet,
          ufvk,
          true,
        );
        if (!result.pcztHex) {
          throw new Error('PCZT build succeeded but pcztHex is empty — reload the extension');
        }
        pcztMultisigRef.current = result;
        setFee((Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
        setStep('airgap-flow');
      } else if (activeZcashWallet?.multisig) {
        // self-custody multisig: zafu has the encrypted FROST share locally.
        // PCZT-native (gh #17): build a standard pczt::Pczt so co-signers can
        // inspect + sighash-verify the spend before signing.
        const authorized = await requestAuth();
        if (!authorized) {
          setStep('review');
          return;
        }
        const ms = activeZcashWallet.multisig;
        const secrets = await useStore
          .getState()
          .keyRing.getMultisigSecrets(activeZcashWallet.vaultId);
        if (!secrets) {
          throw new Error('failed to decrypt multisig keys - unlock wallet first');
        }
        if (!ufvk) {
          throw new Error('UFVK required for multisig PCZT build');
        }
        // frost=true: see the airgap branch above — post-NU6.3 the worker
        // refuses rather than build an ironwood PCZT the FROST rounds and
        // complete_orchard_pczt (orchard/v5-only) cannot consume.
        const result = await buildSendTxPcztInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          0,
          mainnet,
          ufvk,
          true,
        );

        setFee((Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));

        setStep('frost-room');
        try {
          const orchardSigs = await runMnemonicFrostSign({
            ms,
            secrets,
            unsigned: result,
            recipient: recipient.trim(),
            amountZat,
            setFrostAbort: a => {
              frostAbortRef.current = a;
            },
            setRoomCode: code => {
              setFrostRoomCode(code);
              setStep('frost-signing');
            },
            setProgress: setFrostProgress,
          });

          setStep('broadcast');
          setFrostProgress('broadcasting...');
          const finalResult = await completeOrchardPcztInWorker(
            walletId,
            zidecarUrl,
            result.pcztHex,
            orchardSigs,
            result.spendIndices,
            result.coldSendId,
          );
          void promoteToBroadcasted(finalResult.txid);
          complete(finalResult.txid);
          setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
          setStep('complete');
          void recordUsage(recipient, 'zcash');
          if (shouldSuggestSave(recipient)) {
            setShowSavePrompt(true);
          }
        } finally {
          frostAbortRef.current = null;
        }
      } else if (isLedgerAccount) {
        // ── ledger hardware wallet (single-signer): WebHID PCZT signing ──
        // Mirrors the zigner BUILD below but swaps the QR round-trip for a
        // WebHID transport: build the same orchard PCZT, sign the SpendAuth
        // sigs on-device, then reuse the FROST-style inject
        // (completeOrchardPcztInWorker) to finalize + broadcast. Purely
        // additive; the mnemonic/zigner/FROST branches are untouched.
        if (!ufvk) {
          throw new Error('UFVK required for ledger signing');
        }
        // WebHID needs a live user gesture in a document that survives the
        // transfer. The toolbar popup is torn down on blur (and the device
        // picker steals focus), so the session dies mid-sign. Refuse up front
        // instead of failing halfway through a signing round.
        if (isPopup()) {
          throw new Error(
            'open zafu in a tab or the side panel to sign with a ledger — usb sessions ' +
              'are dropped when the toolbar popup loses focus',
          );
        }
        // 0 = "no hint" sentinel; the worker anchors to the live tip (same as
        // the zigner branch).
        const targetHeightHint = 0;
        const result = await buildSendTxPcztInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          targetHeightHint,
          mainnet,
          ufvk,
        );

        // Ironwood (NU6.3 / V6) is not implemented for ledger. The build tags
        // the UR type: 'zcash-pczt' for an orchard PCZT, the zigner-module
        // envelope for an ironwood send. This MUST fail closed: an absent or
        // unrecognised tag previously skipped the check entirely
        // (`if (buildUrType && ...)`), which would have handed an ironwood
        // build to the orchard-V5 translator.
        const buildUrType = result.urFrames[0]?.split('/')[0]?.replace(/^ur:/i, '');
        if (buildUrType !== 'zcash-pczt') {
          throw new Error(
            `ledger signing supports orchard (V5) PCZTs only; this build is ` +
              `"${buildUrType ?? 'untagged'}". note that NU6.3 disabled orchard→orchard ` +
              `sends on mainnet, so ledger shielded sends are unavailable until ` +
              `ironwood (V6) support lands.`,
          );
        }

        pcztUnsignedRef.current = result;
        const feeZec = (Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setFee(feeZec);

        // show the "confirm on your Ledger" prompt while the device signs.
        setStep('ledger-sign');

        // TODO(ledger-session): the connected Ledger sessionId should be
        // plumbed from the connect/pair step (a keyring or dedicated ledger
        // store slice populated when the device is paired during onboarding).
        // Until that plumbing lands, (re)open a session here to sign this round.
        // Ledger as a composed ExternalSigner service (server-as-a-function):
        // the WebHID sign is the base service; the feature-flag + app-version
        // gates are filters. The send flow just picks the service and calls it.
        const session = await connectLedger();
        const ledgerSign = ledgerSignerFor(session);
        const { orchardSigs, spendIndices } = await ledgerSign({
          pcztHex: result.pcztHex,
          spendIndices: result.spendIndices,
          mainnet,
        });

        setStep('broadcast');
        const finalResult = await completeOrchardPcztInWorker(
          walletId,
          zidecarUrl,
          result.pcztHex,
          orchardSigs,
          spendIndices,
          result.coldSendId,
        );
        pcztUnsignedRef.current = null;
        void promoteToBroadcasted(finalResult.txid);
        complete(finalResult.txid);
        setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      } else {
        // ── zigner wallet (single-signer): PCZT signing flow ──
        // Replaces the legacy [sighash][alphas][summary] simple format. The
        // PCZT round-trip ties zigner's display to the signed bytes so a
        // compromised hot wallet can't decouple them.
        if (!ufvk) {
          throw new Error('UFVK required for zigner signing');
        }
        // The worker overrides this with the live chain tip; we pass 0 as
        // a "no hint" sentinel that the worker treats as "use the tip you
        // just fetched for the merkle anchor". Hardcoding a stale block
        // height here historically risked branch_id mismatches on testnet
        // where activation heights diverge from mainnet.
        const targetHeightHint = 0;
        const result = await buildSendTxPcztInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          targetHeightHint,
          mainnet,
          ufvk,
        );

        pcztUnsignedRef.current = result;
        const feeZec = (Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setFee(feeZec);
        setPcztSignFrames(result.urFrames);
        // e.g. "ur:zigner-module/1-3/..." -> "zigner-module" (ironwood),
        // "ur:zcash-pczt/..." -> "zcash-pczt" (orchard). The zigner replays the
        // signed PCZT under this same type, so the return scanner must match it.
        const displayUrType = result.urFrames[0]?.split('/')[0]?.replace(/^ur:/i, '');
        setPcztSignedUrType(displayUrType || 'zcash-pczt');

        startSigning({
          id: `zcash-${Date.now()}`,
          network: 'zcash',
          summary: result.summary || `send ${amount} zec to ${recipient.slice(0, 20)}...`,
          // legacy field kept for the signing-store consumers; the actual
          // QR data the UI displays is `pcztSignFrames` (animated UR).
          signRequestQr: '',
          recipient,
          amount,
          fee: feeZec,
          createdAt: Date.now(),
        });

        setStep('sign');
      }
    } catch (err) {
      frostAbortRef.current?.abort();
      frostAbortRef.current = null;
      const reason = err instanceof Error ? err.message : 'failed to build transaction';
      void markPendingFailed(reason);
      setFormError(reason);
      setStep('error');
    }
  };

  const handleScanSignature = () => {
    setStep('scan');
    startScanning();
  };

  const handleSignatureScanned = useCallback(
    async (data: string) => {
      if (!isZcashSignatureQR(data)) {
        const reason = 'invalid signature qr code';
        void markPendingFailed(reason);
        setError(reason);
        setStep('error');
        return;
      }

      try {
        const sigResponse = parseZcashSignatureResponse(data);
        console.log('signature received:', {
          orchardSigs: sigResponse.orchardSigs.length,
          transparentSigs: sigResponse.transparentSigs.length,
        });

        processSignature(data);
        setStep('broadcast');

        if (!unsignedTxRef.current || !selectedKeyInfo) {
          throw new Error('missing unsigned transaction data');
        }

        // convert signatures to hex strings for worker
        const signatures = {
          orchardSigs: sigResponse.orchardSigs.map(s => bytesToHex(s)),
          transparentSigs: sigResponse.transparentSigs.map(s => bytesToHex(s)),
        };

        const result = await completeSendTxInWorker(
          'zcash',
          selectedKeyInfo.id,
          zidecarUrl,
          unsignedTxRef.current.unsignedTx,
          signatures,
          unsignedTxRef.current.spendIndices,
          // lets the worker mark the spent inputs and record the send; without
          // it the completion sees only signed bytes
          unsignedTxRef.current.coldSendId,
        );

        unsignedTxRef.current = null;
        void promoteToBroadcasted(result.txid);
        complete(result.txid);
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      } catch (err) {
        unsignedTxRef.current = null;
        const reason = err instanceof Error ? err.message : 'failed to broadcast transaction';
        void markPendingFailed(reason);
        setError(reason);
        setStep('error');
      }
    },
    [
      processSignature,
      complete,
      setError,
      selectedKeyInfo,
      zidecarUrl,
      recipient,
      recordUsage,
      shouldSuggestSave,
      promoteToBroadcasted,
      markPendingFailed,
    ],
  );

  /**
   * PCZT-mode receive handler. The animated scanner has already accumulated
   * `ur:zcash-pczt/...` frames and reconstructed the CBOR-wrapped payload via
   * the wasm fountain decoder; we strip the `{1: bytes}` envelope to recover
   * the raw PCZT, hex-encode, and hand to the worker for tx extraction +
   * broadcast.
   */
  const handlePcztSignatureScanned = useCallback(
    async (cborBytes: Uint8Array) => {
      try {
        setStep('broadcast');
        if (!selectedKeyInfo) {
          throw new Error('no wallet selected');
        }

        // Unwrap CBOR `{1: bytes}`. Multiple response shapes ride the animated QR:
        //   - legacy `ur:zcash-pczt`: the CBOR wrap directly encloses the raw
        //     signed PCZT (encode_signed_pczt_ur).
        //   - ironwood `ur:zigner-module`: the device CBOR-wraps its prelude
        //     response ENVELOPE `[0x53][0x04][0x03] || digest:32 || len:u32(LE)
        //     || signed_pczt` (rust/signer module_response_to_ur).
        //   - compact `ur:zigner-module`: the device CBOR-wraps a prelude
        //     compact response `[0x53][0x04][0x07|0x08]` with signatures only.
        const unwrapped = unwrapCborSinglePczt(cborBytes);

        // Detect and handle compact response (tx_type 0x07/0x08)
        if (unwrapped.length >= 3 && unwrapped[0] === 0x53 && unwrapped[1] === 0x04) {
          const txType = unwrapped[2];
          if (txType === 0x07 || txType === 0x08) {
            // Bind accepted-format to requested-format: a compact response is
            // only valid as the answer to a compact request. Since this leg
            // never requested compact, this always fails closed today (see
            // the comment on pcztRequestWasCompactRef) rather than trusting
            // an unrequested response shape.
            if (!pcztRequestWasCompactRef.current) {
              throw new Error(
                'received a compact (signatures-only) response but this request was not sent as compact',
              );
            }

            // Compact response: parse signatures and merge into original PCZTs
            if (!pcztUnsignedRef.current) {
              throw new Error('no unsigned PCZT in context for compact merge');
            }

            const originalPcztHex = pcztUnsignedRef.current.pcztHex;
            const { version, messages } = parseCompactResponse(unwrapped);
            if (version !== SUPPORTED_COMPACT_RESPONSE_VERSION) {
              throw new Error(
                `unsupported compact response version "${version}" (expected "${SUPPORTED_COMPACT_RESPONSE_VERSION}")`,
              );
            }

            // Call wasm apply_signature_contributions to merge sigs
            // Note: this is provided in parallel by another agent and may not exist yet
            // For now, we assume it's available on the worker/wasm module context
            const wasmModule = (globalThis as any).wasmModule;
            if (!wasmModule || typeof wasmModule.apply_signature_contributions !== 'function') {
              throw new Error(
                'wasm apply_signature_contributions not available - ' +
                  'compact signing support not yet shipped',
              );
            }

            // Exactly one PCZT went out on this leg, so exactly one message
            // must come back; mergeContributions enforces this (and that it
            // isn't empty) and throws rather than passing an unsigned PCZT
            // through as though it had been signed.
            const updatedHexes = mergeContributions(
              [originalPcztHex],
              messages,
              wasmModule.apply_signature_contributions,
            );
            const pcztHex = updatedHexes[0]!;

            const result = await completeSendTxPcztInWorker(
              'zcash',
              selectedKeyInfo.id,
              zidecarUrl,
              pcztHex,
              pcztUnsignedRef.current.coldSendId,
            );
            pcztUnsignedRef.current = null;
            void promoteToBroadcasted(result.txid);
            complete(result.txid);
            setStep('complete');
            void recordUsage(recipient, 'zcash');
            if (shouldSuggestSave(recipient)) {
              setShowSavePrompt(true);
            }
            return;
          }
        }

        // Legacy full-PCZT response path (0x03 or raw bytes). Symmetric to
        // the compact check above: a legacy response is only valid as the
        // answer to a legacy request.
        if (pcztRequestWasCompactRef.current) {
          throw new Error(
            'received a legacy full-PCZT response but this request was sent as compact',
          );
        }
        const preluded =
          unwrapped.length >= 3 &&
          unwrapped[0] === 0x53 &&
          unwrapped[1] === 0x04 &&
          unwrapped[2] === 0x03;
        const pcztBytes = preluded
          ? parsePreludeSinglePcztResponse(unwrapped).signedPczt
          : unwrapped;
        let pcztHex = '';
        for (let i = 0; i < pcztBytes.length; i++) {
          pcztHex += pcztBytes[i]!.toString(16).padStart(2, '0');
        }

        const result = await completeSendTxPcztInWorker(
          'zcash',
          selectedKeyInfo.id,
          zidecarUrl,
          pcztHex,
          // lets the worker mark the spent inputs and record the send; the
          // signed PCZT alone cannot say which notes this spent
          pcztUnsignedRef.current?.coldSendId,
        );
        pcztUnsignedRef.current = null;
        void promoteToBroadcasted(result.txid);
        complete(result.txid);
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      } catch (err) {
        pcztUnsignedRef.current = null;
        const reason = err instanceof Error ? err.message : 'failed to extract / broadcast PCZT';
        void markPendingFailed(reason);
        setError(reason);
        setStep('error');
      }
    },
    [
      complete,
      setError,
      selectedKeyInfo,
      zidecarUrl,
      recipient,
      recordUsage,
      shouldSuggestSave,
      promoteToBroadcasted,
      markPendingFailed,
    ],
  );

  const handleBack = () => {
    switch (step) {
      case 'review':
        setStep('form');
        break;
      case 'building':
        setStep('review');
        break;
      case 'sign':
        setStep('review');
        break;
      case 'scan':
        setStep('sign');
        break;
      case 'ledger-sign':
        // signing is in-flight on the device; back returns to review.
        setStep('review');
        break;
      case 'frost-room':
      case 'frost-signing':
      case 'airgap-flow':
        frostAbortRef.current?.abort();
        frostAbortRef.current = null;
        setStep('review');
        break;
      case 'error':
        setStep('review');
        break;
      default:
        onClose();
    }
  };

  const handleClose = () => {
    frostAbortRef.current?.abort();
    frostAbortRef.current = null;
    reset();
    onClose();
  };

  // airgap-flow finished: broadcast with the aggregated orchard sigs.
  const handleAirgapComplete = async (orchardSigs: string[]) => {
    setStep('broadcast');
    try {
      const result = pcztMultisigRef.current!;
      const finalResult = await completeOrchardPcztInWorker(
        selectedKeyInfo!.id,
        zidecarUrl,
        result.pcztHex,
        orchardSigs,
        result.spendIndices,
      );
      void promoteToBroadcasted(finalResult.txid);
      complete(finalResult.txid);
      setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
      setStep('complete');
      void recordUsage(recipient, 'zcash');
      if (shouldSuggestSave(recipient)) {
        setShowSavePrompt(true);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'broadcast failed';
      void markPendingFailed(reason);
      setFormError(reason);
      setStep('error');
    }
  };

  // render based on current step
  const renderContent = () => {
    switch (step) {
      case 'form':
        return (
          <div className='flex flex-col gap-4 p-4'>
            <div className='flex items-center gap-3'>
              <button
                onClick={onClose}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left h-5 w-5' />
              </button>
              <h2 className='text-lg font-medium'>send zcash</h2>
            </div>

            <div className='flex flex-col gap-3'>
              <div>
                <label className='mb-1 block text-xs text-fg-muted'>recipient address</label>
                <div className='flex gap-1'>
                  <input
                    type='text'
                    placeholder='u1... / zs... / t1...'
                    value={recipient}
                    onChange={e => setRecipient(e.target.value)}
                    className='flex-1 rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none'
                  />
                  <button
                    type='button'
                    onClick={() => setShowQrScanner(true)}
                    className='shrink-0 flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-border-soft bg-input text-fg-muted hover:text-fg-high transition-colors'
                    title='scan QR code'
                  >
                    <span className='i-lucide-scan h-4 w-4' />
                  </button>
                </div>
                {showQrScanner && (
                  <QrScanner
                    onScan={data => {
                      const addr = data.startsWith('zcash:') ? data.slice(6).split('?')[0]! : data;
                      setRecipient(addr);
                      setShowQrScanner(false);
                    }}
                    onClose={() => setShowQrScanner(false)}
                    title='scan address'
                    description='scan a zcash address QR code'
                    inline
                  />
                )}
                <RecipientPicker
                  network='zcash'
                  onSelect={addr => {
                    setRecipient(addr);
                    setShowContacts(false);
                  }}
                  show={!recipient}
                />
              </div>

              <div>
                <div className='flex items-center justify-between mb-1'>
                  <label className='text-xs text-fg-muted'>amount (zec)</label>
                  {balanceZat !== null && (
                    // named "spendable", not "balance": this is the active
                    // pool only, and it deliberately differs from the home
                    // screen's total, which includes orchard and transparent
                    <span className='text-xs text-fg-muted tabular-nums'>
                      spendable: <Sensitive>{fmtZecShort(balanceZat)} ZEC</Sensitive>
                    </span>
                  )}
                </div>
                <div className='flex gap-1'>
                  <input
                    type='number'
                    placeholder='0.0'
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    step='0.0001'
                    min='0'
                    className='flex-1 rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none'
                  />
                  <button
                    type='button'
                    // MAX is the amount a transaction can actually be BUILT
                    // for: every note in the pool, minus the ZIP-317 fee that
                    // transaction really pays. Not balance minus a flat 10,000.
                    onClick={() =>
                      setAmount(maxSend.amountZat > 0n ? fmtZecShort(maxSend.amountZat) : '0')
                    }
                    disabled={maxSend.amountZat <= 0n}
                    className='shrink-0 h-[42px] rounded-lg border border-border-soft bg-input px-3 text-xs text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50'
                  >
                    max
                  </button>
                </div>
                {/* Inline validation, all of it computed from the same fee
                    arithmetic the worker will use at build time. */}
                {balanceZat === 0n && strandedZat === 0n && (
                  <p className='mt-1.5 text-label text-amber-400 leading-snug'>
                    no zec yet - receive first from the home screen.
                  </p>
                )}
                {/* Orchard funds are real but consensus-disabled post-NU6.3.
                    Silently folding them into "your balance" is what produced
                    a send that failed after a two-minute prove. Name them, and
                    say what actually releases them. */}
                {strandedZat > 0n && (
                  <p className='mt-1.5 text-label text-amber-400 leading-snug tabular-nums'>
                    <Sensitive>{fmtZecShort(strandedZat)} ZEC</Sensitive> is in the legacy orchard
                    pool and cannot be sent. migrate it to ironwood from the home screen to spend
                    it.
                  </p>
                )}
                {amountQuote !== null && !amountQuote.ok && (
                  <p className='mt-1.5 text-label text-red-400 leading-snug tabular-nums'>
                    exceeds spendable balance — at most{' '}
                    <Sensitive>{fmtZecShort(maxSend.amountZat)} ZEC</Sensitive> after a{' '}
                    <Sensitive>{fmtZecShort(maxSend.feeZat)} ZEC</Sensitive> fee
                  </p>
                )}
                {amountQuote !== null && amountQuote.ok && (
                  <p className='mt-1.5 text-label text-fg-muted leading-snug tabular-nums'>
                    fee <Sensitive>{fmtZecShort(amountQuote.feeZat)} ZEC</Sensitive> ·{' '}
                    {amountQuote.nSpends} note{amountQuote.nSpends === 1 ? '' : 's'} spent
                  </p>
                )}
              </div>

              <div>
                <label className='mb-1 block text-xs text-fg-muted'>memo (optional)</label>
                <input
                  type='text'
                  placeholder='private message'
                  value={memo}
                  onChange={e => setMemo(e.target.value)}
                  maxLength={512}
                  className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none'
                />
              </div>

              {formError && <p className='text-sm text-red-400'>{formError}</p>}
            </div>

            <div className='flex gap-2 mt-4'>
              <Button variant='secondary' onClick={handleClose} className='flex-1'>
                cancel
              </Button>
              <Button variant='gradient' onClick={handleReview} className='flex-1'>
                continue
              </Button>
            </div>
          </div>
        );

      case 'review':
        return (
          <div className='flex flex-col gap-4 p-4'>
            <div className='flex items-center gap-2'>
              <button
                onClick={handleBack}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left w-5 h-5' />
              </button>
              <h2 className='text-lg font-medium'>review transaction</h2>
            </div>

            <div className='bg-elev-1 border border-border-soft rounded-lg p-4 flex flex-col gap-3'>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>network</span>
                <span className='font-medium'>zcash {mainnet ? 'mainnet' : 'testnet'}</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>to</span>
                <span className='font-mono text-sm truncate max-w-[180px]'>{recipient}</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>amount</span>
                <span className='font-medium tabular-nums'>
                  <Sensitive>{amount} zec</Sensitive>
                </span>
              </div>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>fee</span>
                <span className='text-sm tabular-nums'>
                  <Sensitive>{fee} zec</Sensitive>
                </span>
              </div>
              <div className='border-t border-border-soft pt-2 flex justify-between'>
                <span className='text-fg-muted'>total</span>
                <span className='font-medium tabular-nums'>
                  <Sensitive>{(Number(amount) + Number(fee)).toFixed(4)} zec</Sensitive>
                </span>
              </div>
            </div>

            <div className='flex gap-2 mt-4'>
              <Button variant='secondary' onClick={handleBack} className='flex-1'>
                back
              </Button>
              <Button variant='gradient' onClick={() => void handleSign()} className='flex-1'>
                {selectedKeyInfo?.type === 'mnemonic'
                  ? 'sign & send'
                  : isLedgerAccount
                    ? 'sign with Ledger'
                    : 'sign with zafu zigner'}
              </Button>
            </div>
          </div>
        );

      case 'building':
        return (
          <div className='flex flex-col items-center gap-4 p-6'>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center'>
              <div className='w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin' />
            </div>
            <h2 className='text-lg font-medium'>building transaction</h2>

            {/* live elapsed timer — ticks every second so the UI never looks frozen */}
            <LiveTimer startMs={buildStartRef.current} />

            {sendSteps.length > 0 ? (
              <div className='w-full max-w-sm flex flex-col gap-1'>
                {sendSteps.map((s, i) => {
                  const isLast = i === sendSteps.length - 1;
                  const prevMs = i > 0 ? sendSteps[i - 1]!.elapsedMs : 0;
                  const stepDuration = ((s.elapsedMs - prevMs) / 1000).toFixed(1);
                  return (
                    <div
                      key={i}
                      className={`flex items-start gap-2 text-xs ${isLast ? 'text-fg' : 'text-fg-muted'}`}
                    >
                      <span className='font-mono w-12 text-right shrink-0'>
                        {(s.elapsedMs / 1000).toFixed(1)}s
                      </span>
                      <span className={isLast ? '' : ''}>
                        {s.step}
                        {s.detail && <span className='text-fg-muted ml-1'>({s.detail})</span>}
                        {!isLast && Number(stepDuration) >= 0.5 && (
                          <span className='text-fg-muted ml-1'>+{stepDuration}s</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className='text-sm text-fg-muted text-center'>preparing...</p>
            )}
          </div>
        );

      case 'sign': {
        const truncAddr = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
        return (
          <div className='flex flex-col h-full'>
            {/* header */}
            <div className='flex items-center gap-2 px-4 py-3 border-b border-border-soft'>
              <button
                onClick={handleBack}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left w-4 h-4' />
              </button>
              <span className='flex-1 text-sm font-medium'>sign with zigner</span>
              <div className='flex items-center gap-1.5'>
                <div className='h-1 w-5 rounded-full bg-zigner-gold' />
                <div className='h-1 w-5 rounded-full bg-elev-2' />
              </div>
              <DontQuitIcon />
            </div>

            <div className='flex flex-col gap-4 p-4 flex-1 overflow-y-auto'>
              {/* QR */}
              <div className='flex justify-center'>
                {pcztSignFrames && pcztSignFrames.length > 0 ? (
                  <AnimatedQrDisplay
                    urFrames={pcztSignFrames}
                    totalBytes={pcztUnsignedRef.current?.cborBytes}
                    size={210}
                    frameInterval={200}
                    title='scan with zafu zigner'
                    description='hold zigner camera steady; multi-frame transfer'
                  />
                ) : signRequestQr ? (
                  <QrDisplay
                    data={signRequestQr}
                    size={210}
                    title='scan with zafu zigner'
                    description='open zafu zigner and scan this qr'
                  />
                ) : null}
              </div>

              {/* tx summary */}
              <div className='rounded-md border border-border-soft bg-elev-1 divide-y divide-border-soft text-xs'>
                <div className='flex items-center justify-between px-3 py-2'>
                  <span className='text-fg-muted'>to</span>
                  <span className='font-mono text-fg-high'>{truncAddr(recipient)}</span>
                </div>
                <div className='flex items-center justify-between px-3 py-2'>
                  <span className='text-fg-muted'>amount</span>
                  <span className='tabular text-fg-high'>
                    <Sensitive>{amount} ZEC</Sensitive>
                  </span>
                </div>
                <div className='flex items-center justify-between px-3 py-2'>
                  <span className='text-fg-muted'>fee</span>
                  <span className='tabular text-fg-dim'>
                    <Sensitive>{fee} ZEC</Sensitive>
                  </span>
                </div>
                {memo && (
                  <div className='flex items-center justify-between px-3 py-2'>
                    <span className='text-fg-muted'>memo</span>
                    <span className='text-fg-high truncate max-w-[60%]'>{memo}</span>
                  </div>
                )}
              </div>

              {/* steps */}
              <ol className='space-y-2'>
                {(
                  [
                    'open zafu zigner on your phone',
                    'scan this QR code',
                    'review and approve',
                  ] as const
                ).map((label, i) => (
                  <li key={i} className='flex items-center gap-2.5 text-xs text-fg-muted'>
                    <span className='flex size-4 shrink-0 items-center justify-center rounded-full bg-zigner-gold/15 text-[9px] text-zigner-gold'>
                      {i + 1}
                    </span>
                    {label}
                  </li>
                ))}
              </ol>
            </div>

            <div className='px-4 py-3 border-t border-border-soft'>
              <Button variant='gradient' onClick={handleScanSignature} className='w-full'>
                scan signature from zigner
              </Button>
            </div>
          </div>
        );
      }

      case 'scan':
        return pcztUnsignedRef.current ? (
          <div className='flex flex-col h-full'>
            {/* header */}
            <div className='flex items-center gap-2 px-4 py-3 border-b border-border-soft'>
              <button
                onClick={() => setStep('sign')}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left w-4 h-4' />
              </button>
              <span className='flex-1 text-sm font-medium'>scan signature</span>
              <div className='flex items-center gap-1.5'>
                <div className='h-1 w-5 rounded-full bg-elev-2' />
                <div className='h-1 w-5 rounded-full bg-zigner-gold' />
              </div>
              <DontQuitIcon />
            </div>

            <div className='flex flex-col gap-3 p-4 flex-1'>
              <p className='text-xs text-fg-muted'>
                point camera at the animated QR shown on your zigner device
              </p>
              <AnimatedQrScanner
                inline
                onComplete={bytes => {
                  void handlePcztSignatureScanned(bytes);
                }}
                onError={err => {
                  setError(err);
                  setStep('error');
                }}
                onClose={() => setStep('sign')}
                title='scan signed PCZT'
                description='hold camera steady on the animated QR'
                urTypeFilter={pcztSignedUrType}
              />
            </div>
          </div>
        ) : (
          <QrScanner
            onScan={handleSignatureScanned}
            onError={err => {
              setError(err);
              setStep('error');
            }}
            onClose={() => setStep('sign')}
            title='scan signature'
            description="point camera at zafu zigner's signature qr code"
          />
        );

      case 'ledger-sign':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='flex items-center gap-2 self-start'>
              <button
                onClick={handleBack}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left w-5 h-5' />
              </button>
              <h2 className='text-lg font-medium'>confirm on your Ledger</h2>
            </div>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center'>
              <span className='i-lucide-usb w-8 h-8 text-zigner-gold' />
            </div>
            <p className='text-sm text-fg-muted text-center'>
              review the recipient, amount, and fee on your Ledger device and approve the orchard
              spend to continue.
            </p>
            <div className='w-full rounded-md border border-border-soft bg-elev-1 divide-y divide-border-soft text-xs'>
              <div className='flex items-center justify-between px-3 py-2'>
                <span className='text-fg-muted'>to</span>
                <span className='font-mono text-fg-high truncate max-w-[60%]'>{recipient}</span>
              </div>
              <div className='flex items-center justify-between px-3 py-2'>
                <span className='text-fg-muted'>amount</span>
                <span className='tabular text-fg-high'>
                  <Sensitive>{amount} ZEC</Sensitive>
                </span>
              </div>
              <div className='flex items-center justify-between px-3 py-2'>
                <span className='text-fg-muted'>fee</span>
                <span className='tabular text-fg-dim'>
                  <Sensitive>{fee} ZEC</Sensitive>
                </span>
              </div>
            </div>
            <div className='flex items-center gap-2 text-xs text-fg-muted'>
              <div className='h-4 w-4 animate-spin rounded-full border-2 border-zigner-gold border-t-transparent' />
              waiting for device confirmation...
            </div>
          </div>
        );

      case 'broadcast':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-pulse'>
              <div className='w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin' />
            </div>
            <h2 className='text-lg font-medium'>broadcasting transaction</h2>
            <p className='text-sm text-fg-muted text-center'>
              sending your transaction to the zcash network...
            </p>
          </div>
        );

      case 'complete':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            {/* the receipt gets stamped — a broadcast tx is sealed (封) */}
            <HankoSeal glyph='封' size='lg' />
            <h2 className='text-lg font-medium'>sealed — transaction sent</h2>
            <p className='text-sm text-fg-muted text-center'>
              {amount} zec sent successfully
              {totalElapsedSec !== null && ` in ${totalElapsedSec}s`}
            </p>
            {txHash && <p className='font-mono text-xs text-fg-muted break-all'>{txHash}</p>}

            {/* save contact prompt */}
            {showSavePrompt && recipient && !findByAddress(recipient) && !showContactModal && (
              <div className='w-full rounded-lg border border-border-soft bg-elev-1 p-3'>
                <div className='flex items-center gap-2 mb-2'>
                  <span className='i-lucide-user h-4 w-4 text-zigner-gold' />
                  <p className='text-sm'>save to contacts?</p>
                </div>
                <div className='flex gap-2'>
                  <Button
                    variant='gradient'
                    size='sm'
                    onClick={() => setShowContactModal(true)}
                    className='flex-1'
                  >
                    save
                  </Button>
                  <Button
                    variant='secondary'
                    size='sm'
                    onClick={() => {
                      void dismissSuggestion(recipient);
                      setShowSavePrompt(false);
                    }}
                    className='flex-1'
                  >
                    skip
                  </Button>
                </div>
              </div>
            )}

            {showContactModal && (
              <SaveContactModal
                address={recipient}
                network='zcash'
                onDone={() => {
                  setShowContactModal(false);
                  setShowSavePrompt(false);
                }}
                onCancel={() => setShowContactModal(false)}
              />
            )}

            <Button variant='gradient' onClick={handleClose} className='w-full mt-4'>
              done
            </Button>
          </div>
        );

      case 'frost-room':
      case 'frost-signing':
        return (
          <div className='flex flex-col items-center gap-6 p-8'>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center'>
              <span className='i-lucide-users w-8 h-8 text-zigner-gold' />
            </div>
            <h2 className='text-lg font-medium'>multisig signing</h2>

            {frostRoomCode && (
              <div className='flex flex-col items-center gap-2'>
                <p className='text-xs text-fg-muted'>share this code with co-signers:</p>
                <div className='rounded bg-elev-2 px-4 py-2 font-mono text-lg'>{frostRoomCode}</div>
              </div>
            )}

            <div className='flex flex-col items-center gap-2'>
              <p className='text-sm'>{frostProgress}</p>
              <div className='h-5 w-5 animate-spin rounded-full border-2 border-zigner-gold border-t-transparent' />
            </div>

            <div className='w-full rounded bg-elev-2 p-3 text-xs text-fg-muted'>
              <p>
                {activeZcashWallet?.multisig?.threshold}-of-
                {activeZcashWallet?.multisig?.maxSigners} threshold
              </p>
              <p className='mt-1'>
                send <Sensitive>{amount} ZEC</Sensitive> to {recipient.slice(0, 16)}...
                {recipient.slice(-8)}
              </p>
              <p className='mt-1'>fee: {fee} ZEC</p>
            </div>

            <Button variant='secondary' onClick={handleClose} className='w-full mt-2'>
              cancel
            </Button>
          </div>
        );

      case 'airgap-flow':
        if (!pcztMultisigRef.current || !activeZcashWallet?.multisig) {
          return null;
        }
        return (
          <FrostAirgapSignFlow
            ms={activeZcashWallet.multisig}
            unsigned={pcztMultisigRef.current}
            recipient={recipient.trim()}
            amount={amount}
            fee={fee}
            onComplete={handleAirgapComplete}
            onCancel={handleClose}
            onError={msg => {
              setFormError(msg);
              setStep('error');
            }}
          />
        );

      case 'error':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center'>
              <span className='i-lucide-x w-8 h-8 text-red-400' />
            </div>
            <h2 className='text-lg font-medium'>transaction failed</h2>
            <p className='text-sm text-red-400 text-center'>
              {formError || signingError || 'an error occurred'}
            </p>
            <div className='flex gap-2 w-full mt-4'>
              <Button variant='secondary' onClick={handleClose} className='flex-1'>
                cancel
              </Button>
              <Button variant='gradient' onClick={handleBack} className='flex-1'>
                try again
              </Button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className='h-full bg-canvas'>
      {PasswordModal}
      {renderContent()}
    </div>
  );
}
