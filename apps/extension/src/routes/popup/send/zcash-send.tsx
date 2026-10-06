/** zcash send: form, review, then the wallet's own signer (resolve.ts), then done */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Sensitive } from '../../../components/sensitive';
import { discardTxOp, writeTxOp } from '../../../tx-ops';
import { useStore } from '../../../state';
import { zignerSigningSelector } from '../../../state/zigner-signing';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { messagesSelector } from '../../../state/messages';
import {
  selectEffectiveKeyInfo,
  selectGetVaultUnlock,
  selectPenumbraOnly,
} from '../../../state/keyring';
import { selectActiveZcashWallet, selectZcashWallets } from '../../../state/wallets';
import { activeZcashStoreId } from '../../../state/pockets';
import {
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  applySignatureContributionsInWorker,
  type SignatureContribution,
  getBalanceInWorker,
  getTransparentUtxosInWorker,
  broadcastRawTxInWorker,
  stopBuildInWorker,
  type SendTxPcztUnsignedResult,
} from '../../../state/keyring/network-worker';
import { BuildStopped, isBuildStopped } from '../../../workers/build-abort';
import { SendRun } from './send-run';
import { isHeartbeat, phaseOf, useSendWatch } from './send-watch';
import { usePoolNotes } from '../../../hooks/zcash-pool-balances';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { nu63ActivationHeight } from '../../../config/feature-flags';
import { maxSendable, quoteSend } from './spendable';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ScreenHeader } from '../../../components/screen-header';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { FrostAirgapSignFlow } from './frost-multisig';
import { DontQuitIcon } from './frost-multisig/helpers';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { ZcashMeRecipientResolver } from '../../../components/zcashme-recipient-resolver';
import { parseZcashMeHandle, type ZcashMeProfile } from '../../../services/zcashme/api';
import { zcashMeLabel } from '../../../services/zcashme/label';
import { directoryProfileByAddress } from '../../../services/zcashme/directory';
import { usePasswordGate } from '../../../hooks/password-gate';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import {
  CAPS,
  PENUMBRA_ONLY,
  walletKind,
  zcashSendRefusal,
  type WalletKind,
} from '../../../signing/wallet-kind';
import { persistentSurface, zcashSignerFor } from '../../../signing/resolve';
import { connectLedgerBtc, zcashTransparentPath } from '../../../ledger/hw-btc-signer';
import { ledgerTransparentSendFlowBtc } from '../../../ledger/hw-btc-flow';
import type { LedgerSigningPhase } from '../../../ledger/zcash-app/contract';
import { openLedger } from '../../../ledger/zcash-app/connect';
import { ledgerGuidance } from '../../../ledger/zcash-app/guidance';
import {
  LedgerOperation,
  assertNoUnresolvedLedgerOperation,
} from '../../../ledger/zcash-app/operation';
import { loadLedgerZcashProtocol } from '../../../ledger/zcash-app/protocol';
import { recoverLedgerOperations } from '../../../ledger/zcash-app/recovery';
import {
  accountStamper,
  buildLedgerSendPczt,
  ledgerAccountFromKeyInfo,
  ledgerNetwork,
  ledgerOperationStore,
  zafuLedgerDeps,
  zafuRecoveryDeps,
} from '../../../ledger/zcash-app/zafu-deps';
import { signAndBroadcast } from '../../../signing/cold-send';
import { createZignerSigner } from '../../../signing/zigner-signer';
import { frostAirgapSigner, frostSelfCustodySigner } from '../../../signing/frost-signer';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { formatZecAmount } from '@repo/wallet/networks/zcash/zip321';
import { looksLikeLink, notYet, parseLink } from '../../../links/router';
import { viaLine } from '../../../links/land';
import {
  Done,
  Footer,
  Main,
  Mark,
  Review,
  Sending,
  Stopped,
  Strip,
  isTransparentAddress,
  shortAddress,
  type SendingNote,
} from './send-ui';
import { AmountField, AddressSheet, ToField } from './send-fields';
import { STAGES, sendStage } from './send-stage';

import { CatchUpNotice, LedgerGone, LedgerSteps, ZignerWrongCode } from './send-states';
import { isLedgerGone } from '../../../ledger/disconnect';
import { zignerCodeChain, type ZignerChain } from '../../../shared/zigner-code';
import { useCatchUp } from '../../../state/witness-rebuild';
import { signedPcztOfAnswer } from '../../../signing/zigner-answer';

const SEND_FLAGS = {
  hardwareWallet: HARDWARE_WALLET_ENABLED,
  ledgerTransparent: LEDGER_TRANSPARENT_ENABLED,
};

interface ZcashSendProps {
  onClose: () => void;
  accountIndex: number;
  mainnet: boolean;
  /** pre-filled values from inbox compose or a link */
  prefill?: {
    recipient?: string;
    amount?: string;
    memo?: string;
    /** where a link in `recipient` came from (see links/land viaLine) */
    via?: string;
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
  | 'ledger-gone'
  | 'frost-room'
  | 'frost-signing'
  | 'airgap-flow';

/** zatoshi → ZEC, trailing zeros trimmed. Matches the formatting used inline. */
const fmtZecShort = (zat: bigint | string | number): string =>
  (Number(zat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

/** who holds the key, for the sign and done screens */
const DEVICE: Partial<Record<WalletKind, string>> = {
  zigner: 'zigner',
  keystone: 'keystone',
  'frost-airgap': 'zigner',
  'ledger-shielded': 'ledger',
  'ledger-transparent': 'ledger',
};

export function ZcashSend({ onClose, accountIndex, mainnet, prefill }: ZcashSendProps) {
  const {
    txHash,
    error: signingError,
    startSigning,
    startScanning,
    complete,
    setError,
    reset,
  } = useStore(zignerSigningSelector);

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave } = useStore(recentAddressesSelector);
  const { findByAddress, markAddressUsed } = useStore(contactsSelector);
  const messages = useStore(messagesSelector);
  // tempTxId for the optimistic outgoing record created on send-click;
  // promoted to the real txid once the build step returns one.
  const pendingTempTxIdRef = useRef<string | null>(null);
  // the transaction tracker's record for this send (home card + toast)
  const trackOpRef = useRef<string | null>(null);
  // this attempt, and the one way to cancel it (see send-run.ts)
  const runRef = useRef<SendRun | null>(null);
  // the reserved line under a running build, beyond what the clock says
  const [sendNote, setSendNote] = useState<Exclude<SendingNote, 'slow'>>('leave');

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
      if (trackOpRef.current) {
        void writeTxOp(trackOpRef.current, {
          status: 'done',
          step: undefined,
          stoppable: false,
          txId: realTxId,
        });
        trackOpRef.current = null;
      }
    },
    [messages],
  );

  /** mark the optimistic record failed if one is still pending. */
  const markPendingFailed = useCallback(
    async (reason: string) => {
      if (trackOpRef.current) {
        void writeTxOp(trackOpRef.current, {
          status: 'failed',
          step: undefined,
          stoppable: false,
          error: reason,
        });
        trackOpRef.current = null;
      }
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
  // unmount effect below re-ran that cleanup on unrelated store churn - an
  // incoming message arriving during a 30s–2min halo2 prove was enough to
  // stamp the live send as over. The actions on the slice are stable, so a ref
  // is the honest way to say "I want the store, not a subscription to it".
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Unmount cleanup. A chrome popup unmounts on any click-outside, and the
  // build/prove/broadcast pipeline it started keeps running, so this CANNOT
  // report failure: we simply stop being able to observe the outcome.
  //
  // 'interrupted' says exactly that. It also leaves the record promotable -
  // the ref is deliberately NOT cleared, so if this unmount was a navigation
  // inside a surviving document (tab / side panel) the in-flight
  // promoteToBroadcasted() still rewrites the temp id to the real txid and
  // moves it on to broadcasting → pending.
  //
  // A cold round (a QR waiting for its scan, a frost room, a ledger that went
  // away) and a cold build whose PCZT only this page could show die with the
  // page: nothing was signed, so that attempt is killed and discarded, never
  // left to read "interrupted". A hot build goes on in the worker.
  //
  // Empty deps: this must run on real unmount and nothing else.
  const stepRef = useRef<SendStep>('form');
  const hotRef = useRef(false);
  useEffect(() => {
    return () => {
      const run = runRef.current;
      const cold = ['sign', 'scan', 'ledger-gone', 'frost-room', 'frost-signing', 'airgap-flow'];
      if (
        run?.live &&
        !run.sent &&
        (cold.includes(stepRef.current) || (stepRef.current === 'building' && !hotRef.current))
      ) {
        void run.cancel();
        return;
      }
      const tempId = pendingTempTxIdRef.current;
      if (tempId !== null) {
        void messagesRef.current.markOutgoingInterrupted(
          tempId,
          'zafu closed while this send was still in progress - it may still have been sent',
        );
      }
    };
  }, []);

  const [step, setStep] = useState<SendStep>('form');
  stepRef.current = step;
  const [recipient, setRecipient] = useState(prefill?.recipient ?? '');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [memo, setMemo] = useState(prefill?.memo ?? '');

  // a scanned or pasted link goes through the link router: a payment request
  // fills the form for review, any other link moves on to the screen it fills
  const navigate = usePopupNav();
  const [requestNote, setRequestNote] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const [linkVia, setLinkVia] = useState<string>();
  // which fields the last request filled: a new request clears those it
  // doesn't set, but never touches what the user typed
  const filledByRequest = useRef({ amount: false, memo: false });
  const applyLink = useCallback((text: string, via?: string): boolean => {
    if (!looksLikeLink(text)) {
      return false;
    }
    setRequestNote(undefined);
    setRequestError(undefined);
    const r = parseLink(text);
    if (r.ok && r.intent.kind !== 'pay') {
      navigate(PopupPath.LINK, { state: { uri: text, via } });
      return true;
    }
    const refusal = r.ok ? notYet(r.intent) : r.reason;
    const p = r.ok && r.intent.kind === 'pay' ? r.intent.payments[0] : undefined;
    if (refusal || !p) {
      setRequestError(refusal);
      return true;
    }
    setLinkVia(via);
    setRecipient(p.address);
    const filled = filledByRequest.current;
    if (p.amountZat !== undefined) {
      setAmount(formatZecAmount(p.amountZat));
    } else if (filled.amount) {
      setAmount('');
    }
    if (p.memo !== undefined) {
      setMemo(p.memo);
    } else if (filled.memo) {
      setMemo('');
    }
    filledByRequest.current = {
      amount: p.amountZat !== undefined,
      memo: p.memo !== undefined,
    };
    const note = [p.label, p.message].filter(Boolean).join(' - ');
    setRequestNote(note || undefined);
    return true;
  }, []);
  // a `zcash:` link handed in as the prefill recipient (inbox, deep links)
  useEffect(() => {
    if (prefill?.recipient) {
      applyLink(prefill.recipient, prefill.via);
    }
    // once, on open
  }, []);
  const [formError, setFormError] = useState<string | null>(null);
  // zigner sign request: the animated UR frames the sign step shows; the scan
  // step reads the signed reply with AnimatedQrScanner.
  const [pcztSignFrames, setPcztSignFrames] = useState<string[] | null>(null);
  // The signed PCZT returns under the SAME UR type the unsigned display frames
  // carry: orchard uses `zcash-pczt`; an ironwood (NU6.3) send uses the
  // zigner-module prelude envelope. Derive the signed-scan filter from the
  // display frames so the return leg matches for both pools (default orchard).
  const [pcztSignedUrType, setPcztSignedUrType] = useState<string>('zcash-pczt');
  const pcztUnsignedRef = useRef<SendTxPcztUnsignedResult | null>(null);
  // Binds the response format handlePcztSignatureScanned is allowed to accept
  // to what was actually sent: a zigner request over the module envelope may
  // go out compact (tx_type 0x05); keystone's `ur:zcash-pczt` never does. A
  // compact answer to a full request (or the reverse) is refused.
  const pcztRequestWasCompactRef = useRef(false);
  // Bridge the suspended zigner signer (signing/zigner-signer.ts) to the camera
  // scan handler: handleSign parks on signAndBroadcast(zignerSigner); the scan
  // handler reconstructs the signed PCZT and resolves the parked Promise via
  // deliver (or rejects via fail). Single-shot, nulled on settle.
  const zignerDeliverRef = useRef<((signedPcztHex: string) => boolean) | null>(null);
  const zignerFailRef = useRef<((err: unknown) => boolean) | null>(null);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  // profile the recipient was resolved from (zcash.me handle -> address).
  // Only meaningful while its address is still the recipient; feeds the
  // save-contact prefill after a successful send.
  const [resolvedProfile, setResolvedProfile] = useState<ZcashMeProfile | null>(null);
  const [fee, setFee] = useState('0.0001');
  // the address book: saved contacts, this wallet's siblings, recent payees
  const [showAddressBook, setShowAddressBook] = useState(false);
  // the address the user picked from the book: kept so the send-time lastUsedAt
  // stamp can fall back to it (findByAddress at send time stays authoritative).
  const [pickedContact, setPickedContact] = useState<{
    contactId: string;
    addressId: string;
    address: string;
  } | null>(null);
  const [showQrScanner, setShowQrScanner] = useState(false);
  // a zigner code for the other chain, seen while scanning for this send's
  const [wrongCode, setWrongCode] = useState<ZignerChain>();
  // The ledger sign round of the current build (connect, sign, broadcast). A
  // device that goes away mid-sign leaves it here, so "reconnect" signs the
  // same build again. Each run is numbered; an older run that settles late
  // (a hung transport after an unplug) says nothing.
  const ledgerRoundRef = useRef<((onSigned: () => void) => Promise<void>) | null>(null);
  const ledgerRunRef = useRef(0);
  // what the ledger zcash app last reported, and the way to stop asking it
  const [ledgerPhase, setLedgerPhase] = useState<LedgerSigningPhase['phase'] | null>(null);
  const ledgerAbortRef = useRef<AbortController | null>(null);
  // airgap FROST multisig builds a PCZT (gh #17)
  const pcztMultisigRef = useRef<SendTxPcztUnsignedResult | null>(null);
  const [sendSteps, setSendSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);
  const buildStartRef = useRef(0);
  // is the build still moving? real time only (send-watch.ts)
  const watch = useSendWatch(
    sendSteps,
    buildStartRef.current,
    step === 'building' || step === 'broadcast',
  );
  // a witness rebuild the worker reported for this build (board StWitness)
  const catchUp = useCatchUp();

  // self-custody multisig (mnemonic FROST) state
  const [frostRoomCode, setFrostRoomCode] = useState('');
  const [frostProgress, setFrostProgress] = useState('');
  const frostAbortRef = useRef<AbortController | null>(null);

  // store access for wallet id and server url
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // the pocket's own worker store - account 0 uses the bare wallet id
  const storeId = useStore(activeZcashStoreId);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const ufvk =
    activeZcashWallet?.ufvk ??
    (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);

  // which signer this wallet holds; the resolver picks its implementation in
  // handleSign, and a kind without a signer for this pool is refused before
  // the form renders.
  const kind = selectedKeyInfo && walletKind(selectedKeyInfo, activeZcashWallet);

  // ── what this form is allowed to say about your money ───────────────────
  //
  // The figure shown here is the balance of the pool this send will actually
  // spend from, not the wallet total. Post-NU6.3 orchard→orchard sends are
  // consensus-disabled, so orchard funds are real but NOT sendable - a wallet
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
  const penumbraOnly = useStore(selectPenumbraOnly);
  const refusal = kind
    ? zcashSendRefusal(kind, SEND_FLAGS, activePool)
    : penumbraOnly && PENUMBRA_ONLY;

  const poolNotes = usePoolNotes(storeId);

  /** unspent note values in the pool this send would spend from */
  const spendableNotes = useMemo(
    () => poolNotes[activePool].filter(n => !n.spent).map(n => BigInt(n.value)),
    [poolNotes, activePool],
  );
  /** value sitting in the pool that CANNOT be spent - orchard, post-NU6.3 */
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
    if (!storeId) {
      return;
    }
    // resolves even for a wallet with no notes at all, which the length check
    // above cannot distinguish from "not fetched yet"
    getBalanceInWorker('zcash', storeId)
      .then(() => setNotesLoaded(true))
      .catch(() => {});
  }, [storeId]);

  const balanceZat = notesLoaded ? spendableNotes.reduce((s, v) => s + v, 0n) : null;

  // this wallet's siblings, offered in the contacts sheet after saved contacts
  const zcashWallets = useStore(selectZcashWallets);
  const ownWallets = zcashWallets
    .filter(w => w.vaultId !== selectedKeyInfo?.id)
    .map(w => ({ label: w.label, address: w.address }));

  /** the saved contact the recipient currently resolves to - the trust signal */
  const recipientContact = useMemo(() => {
    const trimmed = recipient.trim();
    return trimmed ? findByAddress(trimmed) : undefined;
  }, [recipient, findByAddress]);

  // A completed send is the moment a saved address is "used": stamp lastUsedAt
  // so the book can rank it, alongside the existing save-contact prompt.
  // findByAddress at send time is the source of truth; the drawer pick is only
  // a fallback for the same address (never required).
  useEffect(() => {
    if (step !== 'complete') {
      return;
    }
    const trimmed = recipient.trim();
    const found = trimmed ? findByAddress(trimmed) : undefined;
    const match = found
      ? { contactId: found.contact.id, addressId: found.address.id }
      : pickedContact && pickedContact.address === trimmed
        ? { contactId: pickedContact.contactId, addressId: pickedContact.addressId }
        : null;
    if (match) {
      void markAddressUsed(match.contactId, match.addressId);
    }
  }, [step, recipient, findByAddress, markAddressUsed, pickedContact]);

  const recipientIsTransparent = isTransparentAddress(recipient);
  // The real max: spends every note in the pool, priced with the ZIP-317 fee
  // that transaction would actually pay. Recomputed when the recipient type
  // changes, because a transparent output is priced differently.
  const maxSend = useMemo(
    () =>
      maxSendable(spendableNotes, {
        transparentRecipient: recipientIsTransparent,
      }),
    [spendableNotes, recipientIsTransparent],
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
    });
  }, [amount, spendableNotes, recipientIsTransparent, notesLoaded]);

  // What the form says about the recipient and the amount, derived as typed.
  // `tm`/`t2` are the testnet transparent prefixes; `utest1` the testnet
  // unified one. Sapling (zs) is not a supported recipient.
  const to = recipient.trim();
  const toValid = /^(u1|utest1|t1|t3|tm|t2)/.test(to);
  const toName =
    recipientContact?.contact.name ??
    (resolvedProfile?.address === to ? zcashMeLabel(resolvedProfile) : undefined);
  const toLabel = toName ?? shortAddress(to);
  const toHelper: [warn: boolean, text: string] = requestError
    ? [true, requestError]
    : to && !toValid && !parseZcashMeHandle(to)
      ? [true, 'please check the address · zafu pays u1 and t1 addresses']
      : toValid
        ? [
            false,
            [
              toName ?? requestNote,
              shortAddress(to),
              recipientIsTransparent ? 'public' : 'shielded',
            ]
              .filter(Boolean)
              .join(' · '),
          ]
        : [false, ''];
  // Priced here, not after a witness build and a halo2 prove: the worker
  // applies the same ZIP-317 arithmetic. Unknown balance (notes not loaded
  // yet) is never read as "too little".
  const overLimit = amountQuote !== null && !amountQuote.ok;
  const canReview = toValid && Number(amount) > 0 && !overLimit;

  // Keep the DISPLAYED fee in step with the quote.
  //
  // `fee` was initialised to the literal '0.0001' and only overwritten from the
  // worker's result - which on the hot path arrives AFTER the transaction has
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
      setFee(fmtZecShort(amountQuote.feeZat));
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
      // what home's card says while this page is gone, and when it stops
      // offering to stop: the worker refuses from the broadcast on
      const op = trackOpRef.current;
      if (detail.step.includes('broadcasting')) {
        runRef.current?.broadcasting();
        if (op) {
          void writeTxOp(op, { status: 'pending', step: 'broadcasting', stoppable: false });
        }
      } else if (op && detail.step === 'catch-up: start') {
        void writeTxOp(op, { status: 'pending', step: 'catching up the note tree' });
      } else if (op && /^(proving|building & proving|building, proving)/.test(detail.step)) {
        void writeTxOp(op, { status: 'pending', step: 'proving' });
      }
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [step]);

  /**
   * Kill and discard the running attempt (send-run.ts). `failed`: zafu ended
   * it, not the person.
   */
  const cancelRun = async (failed?: string) => {
    const run = runRef.current;
    if (!run) {
      return 'stopped' as const;
    }
    const result = await run.cancel(failed);
    if (result === 'stopped') {
      pendingTempTxIdRef.current = null;
      trackOpRef.current = null;
      ledgerRunRef.current++;
      ledgerRoundRef.current = null;
      pcztUnsignedRef.current = null;
      pcztMultisigRef.current = null;
    }
    return result;
  };

  // A build that has gone quiet far past its phase's bound is ended, calmly:
  // before the broadcast it is stopped and nothing was sent; after it, zafu
  // can only say it did not hear back.
  useEffect(() => {
    if (watch !== 'timeout') {
      return;
    }
    const run = runRef.current;
    const quietAt = sendSteps.findLast(p => !isHeartbeat(p.step))?.step;
    if (run?.sent || step === 'broadcast' || phaseOf(quietAt) === 'broadcast') {
      const reason =
        'zafu did not hear back from the network · it may still arrive, so please look at home before sending again';
      const tempId = pendingTempTxIdRef.current;
      pendingTempTxIdRef.current = null;
      if (tempId) {
        void messages.markOutgoingInterrupted(tempId, reason);
      }
      if (trackOpRef.current) {
        void writeTxOp(trackOpRef.current, {
          status: 'unknown',
          step: undefined,
          stoppable: false,
        });
        trackOpRef.current = null;
      }
      run?.finish();
      setFormError(reason);
      setStep('error');
      return;
    }
    const reason = 'this took far longer than it should, so zafu stopped it · nothing was sent';
    void cancelRun(reason).then(result => {
      if (result === 'on-its-way') {
        setSendNote('on-its-way');
        return;
      }
      setFormError(reason);
      setStep('error');
    });
    // once per timeout
  }, [watch]);

  /** "stop this send": back to review with the form as it was */
  const stopSend = async () => {
    setSendNote('stopping');
    const result = await cancelRun();
    if (result === 'on-its-way') {
      setSendNote('on-its-way');
      return;
    }
    setSendNote('leave');
    setStep('review');
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
    setSendNote('leave');
    buildStartRef.current = Date.now();
    hotRef.current = kind === 'hot';
    const run = new SendRun({
      stopBuild: key => stopBuildInWorker('zcash', key),
      discard: (opId, tempId) => {
        void discardTxOp(opId);
        if (tempId) {
          void messages.markOutgoingDiscarded(tempId);
        }
      },
      fail: (opId, tempId, reason) => {
        void writeTxOp(opId, {
          status: 'failed',
          step: undefined,
          stoppable: false,
          error: reason,
          notified: true,
        });
        if (tempId) {
          void messages.markOutgoingFailed(tempId, reason);
        }
      },
    });
    runRef.current = run;

    // optimistic outgoing entry - visible in inbox immediately, before
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
      run.tempTxId = tempTxId;
    } catch (e) {
      console.warn('[zcash-send] failed to record optimistic pending:', e);
      pendingTempTxIdRef.current = null;
    }
    // Tracker record. If this page closes mid-send it stays pending and the
    // sweep later says 'unknown' - it may still have been sent.
    trackOpRef.current = run.key;
    void writeTxOp(run.key, {
      network: 'zcash',
      label: `send ${amount} ZEC`,
      status: 'pending',
      step: 'building',
      startedAt: Date.now(),
      // home can stop it while it builds, under the same key
      stoppable: true,
      ...(run.tempTxId ? { outboxId: run.tempTxId } : {}),
    });

    try {
      const walletId = selectedKeyInfo.id;
      const amountZat = Math.round(Number(amount) * 1e8).toString();
      const coldDeps = { walletId: storeId ?? walletId, zidecarUrl, mainnet };
      const finish = (txid: string) => {
        run.broadcasting();
        run.finish();
        void promoteToBroadcasted(txid);
        complete(txid);
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      };
      // The worker overrides the height with the live chain tip; 0 is a "no
      // hint" sentinel that anchors to the tip it just fetched. A hardcoded
      // height historically risked branch_id mismatches on testnet.
      const buildPczt = async (frost = false) => {
        if (!ufvk) {
          throw new Error('this wallet has no viewing key to build with · please re-import it');
        }
        const result = await buildSendTxPcztInWorker(
          'zcash',
          storeId ?? walletId,
          zidecarUrl,
          recipient.trim(),
          amountZat,
          memo,
          0,
          mainnet,
          ufvk,
          frost,
          undefined,
          run.key,
          // zigner reads every orchard send over its module envelope; keystone keeps ur:zcash-pczt
          kind === 'zigner',
        );
        if (!run.live) {
          throw new BuildStopped();
        }
        setFee(fmtZecShort(result.fee));
        return result;
      };

      // one implementation per signer; the resolver picks the wallet's own,
      // or refuses without calling any of them.
      await zcashSignerFor(kind ?? 'unknown', SEND_FLAGS, activePool, {
        hot: async () => {
          // verify password, then build signed tx + broadcast
          const authorized = await requestAuth();
          if (!authorized) {
            // a dismissed password cancels the send: nothing was built
            await cancelRun();
            setStep('review');
            return;
          }
          // the build's clock starts now, not while the password was asked
          buildStartRef.current = Date.now();
          setSendSteps([]);
          const vault = await getVaultUnlock(walletId);
          const result = await buildSendTxInWorker(
            'zcash',
            storeId ?? walletId,
            zidecarUrl,
            recipient.trim(),
            amountZat,
            memo,
            accountIndex,
            mainnet,
            vault,
            undefined,
            run.key,
          );
          if ('txid' in result) {
            setFee(fmtZecShort(result.fee));
            finish(result.txid);
          }
        },

        'ledger-transparent': persistentSurface(async () => {
          // hw-app-btc t->t send. No PCZT: fetch UTXOs, plan, sign the whole
          // transparent tx on the device's Zcash (Bitcoin-app) path, broadcast.
          // Nothing is built ahead of the device, so a retry plans again.
          const fromAddress = activeZcashWallet!.transparentAddress!; // implied by the kind
          // ZIP-317 transparent fee: a conservative fixed estimate covering a
          // few logical actions. A slightly-high fee still confirms.
          const feeZat = 20000n;
          setFee(fmtZecShort(feeZat));
          await runLedgerRound(async onSigned => {
            setStep('ledger-sign');
            const transport = await connectLedgerBtc();
            // a pending read never settles on unplug; the transport's own
            // disconnect event ends the round instead
            const unplugged = new Promise<never>((_, reject) =>
              transport.on('disconnect', () => reject(new Error('DisconnectedDevice'))),
            );
            // a cancelled send closes the device channel: a later approval on
            // the device can no longer reach the broadcast
            const release = run.hold(() => void transport.close().catch(() => undefined));
            try {
              const { txid } = await Promise.race([
                ledgerTransparentSendFlowBtc(
                  transport,
                  {
                    serverUrl: zidecarUrl,
                    fromAddresses: [fromAddress],
                    recipientAddress: recipient.trim(),
                    amountZat: BigInt(amountZat),
                    feeZat,
                    change: { address: fromAddress, path: zcashTransparentPath(0) },
                    accountIndex: 0,
                    mainnet,
                    blockHeight: sendChainHeight,
                  },
                  {
                    fetchUtxos: getTransparentUtxosInWorker,
                    // the device has signed by the time the flow broadcasts
                    broadcast: (...args) => {
                      onSigned();
                      return broadcastRawTxInWorker(...args);
                    },
                  },
                ),
                unplugged,
              ]);
              finish(txid);
            } finally {
              release();
              await transport.close().catch(() => undefined);
            }
          });
        }),

        'frost-airgap': async () => {
          // build a PCZT (gh #17) then hand off to FrostAirgapSignFlow
          const result = await buildPczt(true);
          if (!result.pcztHex) {
            throw new Error(
              "zafu couldn't finish this send · nothing was sent, please reload zafu",
            );
          }
          pcztMultisigRef.current = result;
          setStep('airgap-flow');
        },

        'frost-self': async () => {
          // zafu has the encrypted FROST share locally. PCZT-native (gh #17):
          // co-signers can inspect + sighash-verify the spend before signing.
          const authorized = await requestAuth();
          if (!authorized) {
            await cancelRun();
            setStep('review');
            return;
          }
          run.hold(() => frostAbortRef.current?.abort());
          const ms = activeZcashWallet!.multisig!; // implied by the kind
          const secrets = await useStore
            .getState()
            .keyRing.getMultisigSecrets(activeZcashWallet!.vaultId);
          if (!secrets) {
            throw new Error("the multisig keys didn't open · please unlock zafu and try again");
          }
          const result = await buildPczt(true);
          setStep('frost-room');
          try {
            // both rounds run inside the signer; room/progress/abort UI stays
            // here via the ctx callbacks, and the orchard sigs are injected by
            // the shared tail (complete_orchard_pczt). See signing/frost-signer.ts.
            const frostSigner = frostSelfCustodySigner({
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
            const finalResult = await signAndBroadcast(
              frostSigner,
              {
                pcztHex: result.pcztHex,
                spendIndices: result.spendIndices,
                coldSendId: result.coldSendId,
              },
              coldDeps,
              {
                onSigned: () => {
                  run.broadcasting();
                  setStep('broadcast');
                  setFrostProgress('broadcasting...');
                },
              },
            );
            finish(finalResult.txid);
          } finally {
            frostAbortRef.current = null;
          }
        },

        'ledger-shielded': persistentSurface(async () => {
          // the zcash app signs the whole PCZT once; the signed tx is
          // checkpointed before it is broadcast, so nothing after the approval
          // ever asks the device again (ledger/zcash-app/operation.ts)
          const ins = selectedKeyInfo.insensitive;
          const account = ledgerAccountFromKeyInfo(ins, Number(ins['accountIndex'] ?? 0));
          const ctx = { walletId: storeId ?? walletId, network: ledgerNetwork(mainnet) };
          await recoverLedgerOperations(zafuRecoveryDeps(zidecarUrl), ctx);
          await assertNoUnresolvedLedgerOperation(ledgerOperationStore(), ctx);
          if (!ufvk) {
            throw new Error('this wallet has no viewing key to build with · please re-import it');
          }
          const built = await buildLedgerSendPczt({
            walletId: ctx.walletId,
            serverUrl: zidecarUrl,
            recipient: recipient.trim(),
            amountZat,
            memo,
            mainnet,
            ufvk,
            cancelKey: run.key,
          });
          if (!run.live) {
            throw new BuildStopped();
          }
          setFee(fmtZecShort(built.fee));
          const protocol = await loadLedgerZcashProtocol();
          const stillHere = () => selectEffectiveKeyInfo(useStore.getState())?.id === walletId;
          await runLedgerRound(async onSigned => {
            setLedgerPhase(null);
            setStep('ledger-sign');
            const device = await openLedger();
            const abort = new AbortController();
            ledgerAbortRef.current = abort;
            const release = run.hold(() => abort.abort());
            try {
              const out = await new LedgerOperation(
                zafuLedgerDeps({
                  protocol,
                  device,
                  stampDerivations: accountStamper(protocol, account),
                  ctx,
                  serverUrl: zidecarUrl,
                  isCurrent: stillHere,
                }),
                ctx,
                {
                  kind: 'send',
                  pcztHex: built.pcztHex,
                  ...(built.coldSendId ? { coldSendId: built.coldSendId } : {}),
                  label: `send ${amount} ZEC`,
                },
              ).run({
                signal: abort.signal,
                onPhase: p => setLedgerPhase(p.phase),
                onStep: s => s === 'saving' && onSigned(),
              });
              if (out.status === 'uncertain') {
                // it may be on chain: the records say so, never "failed"
                const reason =
                  'this may already have been sent · zafu is confirming it from the chain, so please do not send it again yet';
                const tempId = pendingTempTxIdRef.current;
                pendingTempTxIdRef.current = null;
                if (tempId) {
                  void messages.markOutgoingInterrupted(tempId, reason);
                }
                if (trackOpRef.current) {
                  void writeTxOp(trackOpRef.current, { status: 'unknown', step: undefined });
                  trackOpRef.current = null;
                }
                throw new Error(reason);
              }
              finish(out.txid);
            } catch (e) {
              if (isLedgerGone(e)) {
                throw e;
              }
              const g = ledgerGuidance(e);
              throw new Error(`${g.title} · ${g.action}`);
            } finally {
              release();
              ledgerAbortRef.current = null;
              await device.close().catch(() => undefined);
            }
          });
        }),

        // zigner, and keystone on orchard: the PCZT QR round trip ties the
        // device's display to the signed bytes, so a compromised hot wallet
        // cannot decouple them.
        zigner: async () => {
          const result = await buildPczt();
          pcztUnsignedRef.current = result;
          // Bind the response type to what actually went out on the wire.
          pcztRequestWasCompactRef.current = result.compactRequest === true;
          // e.g. "ur:zigner-module/1-3/..." -> "zigner-module" (ironwood),
          // "ur:zcash-pczt/..." -> "zcash-pczt" (orchard). The zigner replays
          // the signed PCZT under this same type, so the return scanner must match.
          const displayUrType = result.urFrames[0]?.split('/')[0]?.replace(/^ur:/i, '');
          setPcztSignedUrType(displayUrType || 'zcash-pczt');

          // A SUSPENDED cold signer (signing/zigner-signer.ts): `display` shows
          // the animated UR, then handlePcztSignatureScanned reconstructs the
          // signed PCZT and resolves the parked Promise via `deliver`.
          // signAndBroadcast then extracts + broadcasts (the `signedPczt`
          // variant, orchard AND ironwood). The signing surface (tab/side-panel)
          // must stay open for the sign->scan duration.
          // eslint-disable-next-line @typescript-eslint/unbound-method -- createZignerSigner returns plain closures, not this-bound methods
          const { signer, deliver, fail } = createZignerSigner(() => {
            setPcztSignFrames(result.urFrames);
            startSigning({
              id: `zcash-${Date.now()}`,
              network: 'zcash',
              summary: result.summary || `send ${amount} zec to ${recipient.slice(0, 20)}...`,
              // legacy field kept for the signing-store consumers; the QR the
              // UI displays is `pcztSignFrames` (animated UR).
              signRequestQr: '',
              recipient,
              amount,
              fee: fmtZecShort(result.fee),
              createdAt: Date.now(),
            });
            setStep('sign');
          });
          zignerDeliverRef.current = deliver;
          zignerFailRef.current = fail;
          run.hold(() => fail(new BuildStopped()));

          const finalResult = await signAndBroadcast(
            signer,
            {
              pcztHex: result.pcztHex,
              spendIndices: result.spendIndices,
              coldSendId: result.coldSendId,
            },
            coldDeps,
            {
              onSigned: () => {
                run.broadcasting();
                setStep('broadcast');
              },
            },
          );
          zignerDeliverRef.current = null;
          zignerFailRef.current = null;
          pcztUnsignedRef.current = null;
          finish(finalResult.txid);
        },
      })();
    } catch (err) {
      // a cancelled attempt was already discarded and put back on review
      if (run.discarded) {
        return;
      }
      if (isBuildStopped(err)) {
        // stopped from another window (home's card): the records are its
        run.finish();
        pendingTempTxIdRef.current = null;
        trackOpRef.current = null;
        setStep('review');
        return;
      }
      failSend(err);
    }
  };

  const failSend = (err: unknown) => {
    runRef.current?.finish();
    frostAbortRef.current?.abort();
    frostAbortRef.current = null;
    const reason =
      err instanceof Error ? err.message : "zafu couldn't build this send · nothing was sent";
    void markPendingFailed(reason);
    setFormError(reason);
    setStep('error');
  };

  /** run (or re-run) the ledger round; a device that went away keeps it */
  const runLedgerRound = async (round: (onSigned: () => void) => Promise<void>) => {
    ledgerRoundRef.current = round;
    const run = ++ledgerRunRef.current;
    let signed = false;
    try {
      await round(() => {
        signed = true;
        runRef.current?.broadcasting();
        setStep('broadcast');
      });
      ledgerRoundRef.current = null;
    } catch (err) {
      if (run !== ledgerRunRef.current) {
        return;
      }
      if (!signed && isLedgerGone(err)) {
        setStep('ledger-gone');
        return;
      }
      ledgerRoundRef.current = null;
      throw err;
    }
  };

  const reconnectLedger = () => {
    const round = ledgerRoundRef.current;
    if (round) {
      runLedgerRound(round).catch(err => {
        if (!runRef.current?.discarded && !isBuildStopped(err)) {
          failSend(err);
        }
      });
    }
  };

  const handleScanSignature = () => {
    setWrongCode(undefined);
    setStep('scan');
    startScanning();
  };

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
        if (!selectedKeyInfo) {
          throw new Error('no wallet selected');
        }

        // Read the signed PCZT out of the scanned answer (compact contributions
        // merged into the PCZT zafu kept, verified in the worker), then hand it
        // to the parked zigner signer via deliver. The shared signAndBroadcast
        // tail - awaited in handleSign - does the extract + broadcast + success
        // UI on resume; this handler ONLY reconstructs.
        const walletId = selectedKeyInfo.id;
        const signedPcztHex = await signedPcztOfAnswer(cborBytes, {
          compact: pcztRequestWasCompactRef.current,
          pcztHex: pcztUnsignedRef.current?.pcztHex ?? '',
          merge: (pczt, contributionsJson) =>
            applySignatureContributionsInWorker(
              'zcash',
              walletId,
              pczt,
              JSON.parse(contributionsJson) as SignatureContribution[],
            ),
        });

        // Resolve the parked signer. If no round is awaiting (shouldn't happen -
        // handleSign parks before the scanner is reachable), that is a caller
        // bug, so surface it rather than silently dropping the signature.
        if (!zignerDeliverRef.current) {
          throw new Error('no zigner signing round is awaiting a signature');
        }
        zignerDeliverRef.current(signedPcztHex);
      } catch (err) {
        const reason =
          err instanceof Error
            ? err.message
            : "zafu couldn't read the signed answer · nothing was sent";
        // Surface the REAL cause. Without this the merge/parse error was only
        // handed to the reject seam as a bare string, so it was neither logged
        // nor shown - every compact failure collapsed to the generic "failed to
        // build transaction" banner (handleSign's catch discards a non-Error
        // rejection). Log it, and reject with a real Error so the message
        // actually reaches the error UI.
        console.error('[zcash] compact signed-PCZT reconstruct/merge failed:', err);
        // Reject the parked signer so handleSign's catch drives the error UI +
        // pending-failed recording (identical to the old inline error path -
        // both render at the error step's `formError || signingError`). Fall
        // back to local error state only if no round is parked.
        if (zignerFailRef.current) {
          zignerFailRef.current(err instanceof Error ? err : new Error(reason));
        } else {
          pcztUnsignedRef.current = null;
          void markPendingFailed(reason);
          setError(reason);
          setStep('error');
        }
      }
    },
    [selectedKeyInfo, markPendingFailed, setError],
  );

  // Backing out of a cold-signing step cancels before anything is broadcast:
  // the round is killed and the send discarded (send-run.ts), never left as a
  // spinner that ends 'unknown'.
  const dropTrackOp = () => void cancelRun();

  const handleBack = () => {
    switch (step) {
      case 'review':
        setStep('form');
        break;
      case 'building':
        void stopSend();
        break;
      case 'sign':
        dropTrackOp();
        setStep('review');
        break;
      case 'scan':
        // back to the same request on screen: the round is still waiting
        setStep('sign');
        break;
      case 'ledger-sign':
        // nothing is signed while the device still asks: let the round go
        ledgerRunRef.current++;
        ledgerRoundRef.current = null;
        ledgerAbortRef.current?.abort();
        dropTrackOp();
        setStep('review');
        break;
      case 'ledger-gone':
        // nothing was signed: let the kept round go, as backing out of zigner does
        ledgerRoundRef.current = null;
        ledgerRunRef.current++;
        pcztUnsignedRef.current = null;
        dropTrackOp();
        setStep('review');
        break;
      case 'frost-room':
      case 'frost-signing':
      case 'airgap-flow':
        frostAbortRef.current?.abort();
        frostAbortRef.current = null;
        dropTrackOp();
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
    if (
      ['sign', 'scan', 'ledger-gone', 'frost-room', 'frost-signing', 'airgap-flow'].includes(step)
    ) {
      dropTrackOp();
    }
    frostAbortRef.current?.abort();
    frostAbortRef.current = null;
    reset();
    onClose();
  };

  // airgap-flow finished: the shared cold tail injects the aggregated orchard
  // sigs under the build's store and send id, so the inputs are marked spent.
  const handleAirgapComplete = async (orchardSigs: string[]) => {
    try {
      const result = pcztMultisigRef.current!;
      const finalResult = await signAndBroadcast(
        frostAirgapSigner(orchardSigs, result),
        result,
        { walletId: storeId ?? selectedKeyInfo!.id, zidecarUrl, mainnet },
        {
          onSigned: () => {
            runRef.current?.broadcasting();
            setStep('broadcast');
          },
        },
      );
      runRef.current?.finish();
      void promoteToBroadcasted(finalResult.txid);
      complete(finalResult.txid);
      setStep('complete');
      void recordUsage(recipient, 'zcash');
      if (shouldSuggestSave(recipient)) {
        setShowSavePrompt(true);
      }
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.message
          : "the network didn't take this send · please look at home before trying again";
      void markPendingFailed(reason);
      setFormError(reason);
      setStep('error');
    }
  };

  const device = (kind && DEVICE[kind]) ?? 'zigner';
  const sending = (
    <>
      send <Sensitive>{amount} zec</Sensitive> to {toLabel}
    </>
  );

  // render based on current step
  const renderContent = () => {
    switch (step) {
      case 'form':
        return (
          <>
            <ScreenHeader title='send zec' onBack={onClose} meta='1 / 2' />
            <Main className='gap-[18px] pt-5'>
              <ToField
                value={recipient}
                onChange={v => {
                  if (!applyLink(v, 'pasted')) {
                    setLinkVia(undefined);
                    setRecipient(v);
                  }
                }}
                warn={toHelper[0]}
                helper={toHelper[1]}
                onContacts={() => setShowAddressBook(true)}
                onScan={() => setShowQrScanner(true)}
              >
                <ZcashMeRecipientResolver
                  input={recipient}
                  onResolve={p => {
                    setResolvedProfile(p);
                    setRecipient(p.address);
                  }}
                />
              </ToField>

              {/* the active pool only, so it can differ from home's total; max is
                every note in the pool minus the ZIP-317 fee that transaction pays */}
              <AmountField
                value={amount}
                onChange={v => {
                  filledByRequest.current.amount = false;
                  setAmount(v);
                }}
                unit='zec'
                available={balanceZat !== null ? fmtZecShort(balanceZat) : undefined}
                onMax={() => {
                  filledByRequest.current.amount = false;
                  setAmount(fmtZecShort(maxSend.amountZat));
                }}
                canMax={maxSend.amountZat > 0n}
                warn={overLimit}
                helper={
                  overLimit ? (
                    <>
                      a little more than you have · up to{' '}
                      <Sensitive>{fmtZecShort(maxSend.amountZat)}</Sensitive>
                    </>
                  ) : (
                    // orchard funds are real but consensus-disabled post-NU6.3:
                    // name them rather than fold them into what can be sent
                    strandedZat > 0n && (
                      <>
                        <Sensitive>{fmtZecShort(strandedZat)} zec</Sensitive> waits in orchard ·
                        migrate it on home to send it
                      </>
                    )
                  )
                }
              />

              <div className='flex flex-col gap-1.5'>
                <label htmlFor='send-memo' className='text-xs text-fg-muted'>
                  memo
                </label>
                <Input
                  id='send-memo'
                  placeholder={`optional, only ${toName ?? 'they'} can read it`}
                  value={memo}
                  onChange={e => {
                    filledByRequest.current.memo = false;
                    setMemo(e.target.value);
                  }}
                  maxLength={512}
                />
              </div>
            </Main>
            <Footer>
              <Button onClick={() => setStep('review')} disabled={!canReview} className='w-full'>
                review
              </Button>
            </Footer>

            {showQrScanner && (
              <QrScanner
                onScan={data => {
                  if (!applyLink(data, 'scanned')) {
                    setLinkVia(undefined);
                    setRecipient(data);
                  }
                  setShowQrScanner(false);
                }}
                onClose={() => setShowQrScanner(false)}
                title='scan an address'
              />
            )}
            <AddressSheet
              chain='zcash'
              open={showAddressBook}
              onOpenChange={setShowAddressBook}
              onScan={() => setShowQrScanner(true)}
              own={ownWallets}
              onPick={row => {
                setRecipient(row.address);
                setPickedContact(
                  row.contactId && row.addressId
                    ? { contactId: row.contactId, addressId: row.addressId, address: row.address }
                    : null,
                );
              }}
            />
          </>
        );

      case 'review':
        return (
          <Review
            amount={amount}
            unit='zec'
            rows={[
              ['to', toName ? `${toName} · ${shortAddress(to)}` : shortAddress(to)],
              ['fee', <Sensitive key='fee'>{fee} zec</Sensitive>],
              [
                'total',
                <Sensitive key='total'>
                  {fmtZecShort(Math.round((Number(amount) + Number(fee)) * 1e8))} zec
                </Sensitive>,
              ],
            ]}
            privacy={
              recipientIsTransparent
                ? 'public · the address and amount are visible to anyone'
                : 'shielded · amount and memo stay private'
            }
            confirm={kind ? CAPS[kind].signLabel : ''}
            onEdit={handleBack}
            onConfirm={() => void handleSign()}
          >
            {linkVia && (
              <span className='text-center text-[11px] text-fg-muted'>{viaLine(linkVia)}</span>
            )}
          </Review>
        );

      // broadcasting is the tail of the same operation: one sending screen
      case 'building':
      case 'broadcast': {
        const sendMeta = (
          <span>
            <Sensitive>{amount} zec</Sensitive> to {toLabel}
          </span>
        );
        // stop is offered only while nothing has left
        const onStop =
          step === 'building' &&
          sendNote !== 'on-its-way' &&
          !runRef.current?.sent &&
          sendStage(STAGES.zcash, sendSteps) < 3
            ? () => void stopSend()
            : undefined;
        const note: SendingNote =
          sendNote !== 'leave' ? sendNote : watch === 'slow' ? 'slow' : 'leave';
        // a catch-up of this build, said the moment it starts
        return catchUp &&
          step === 'building' &&
          sendSteps.some(p => p.step === 'catch-up: start') ? (
          <CatchUpNotice
            catchUp={catchUp}
            meta={sendMeta}
            note={note}
            onStop={onStop}
            onClose={onClose}
          />
        ) : (
          <Sending
            meta={sendMeta}
            stages={STAGES.zcash}
            steps={sendSteps}
            floor={step === 'broadcast' ? 3 : 0}
            since={buildStartRef.current}
            hot={kind === 'hot'}
            note={note}
            onStop={onStop}
            onClose={onClose}
          />
        );
      }

      case 'sign':
      case 'scan':
        return step === 'scan' && wrongCode ? (
          <ZignerWrongCode
            device={device}
            shown={wrongCode}
            wanted='zcash'
            sending={sending}
            onBack={() => {
              setWrongCode(undefined);
              setStep('sign');
            }}
            onScanAgain={() => setWrongCode(undefined)}
          />
        ) : (
          <>
            <ScreenHeader
              title={`sign on ${device}`}
              onBack={step === 'sign' ? handleBack : () => setStep('sign')}
              meta={
                <>
                  {step === 'sign' ? '1 / 2' : '2 / 2'}
                  <DontQuitIcon />
                </>
              }
            />
            <Strip
              icon='i-lucide-asterisk text-device-blue'
              right={<Sensitive>fee {fee}</Sensitive>}
            >
              {sending}
            </Strip>
            <Main className='items-center gap-4 px-5 pt-6'>
              {step === 'scan' ? (
                <>
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
                    title={`${device}'s answer`}
                    urTypeFilter={pcztSignedUrType}
                    onForeign={text => {
                      const chain = zignerCodeChain(text);
                      if (chain && chain !== 'zcash') {
                        setWrongCode(chain);
                      }
                    }}
                  />
                  <span className='text-[13px] text-fg-high'>
                    hold {device}'s signed qr up to the camera
                  </span>
                </>
              ) : (
                <>
                  {pcztSignFrames && pcztSignFrames.length > 0 && (
                    <AnimatedQrDisplay
                      bare
                      urFrames={pcztSignFrames}
                      urSource={
                        pcztUnsignedRef.current?.cborData
                          ? {
                              bytes: pcztUnsignedRef.current.cborData,
                              urType:
                                pcztSignFrames[0]?.split('/')[0]?.replace(/^ur:/i, '') ||
                                'zcash-pczt',
                            }
                          : undefined
                      }
                      totalBytes={pcztUnsignedRef.current?.cborBytes}
                      // as large as the surface allows, so a phone camera locks on
                      size={300}
                      frameInterval={200}
                    />
                  )}
                  <span className='text-[13px] text-fg-high'>
                    scan this with {device}, approve there
                  </span>
                </>
              )}
            </Main>
            <Footer>
              {step === 'sign' ? (
                <Button onClick={handleScanSignature} className='w-full'>
                  scan {device}'s answer
                </Button>
              ) : (
                <Button disabled className='w-full'>
                  waiting for signature
                </Button>
              )}
            </Footer>
          </>
        );

      // the zcash app reports each step; the bitcoin app only the last
      case 'ledger-sign':
        return (
          <>
            <ScreenHeader title='confirm on ledger' backPath={false} />
            <Strip right={recipientIsTransparent ? 'transparent · public' : 'shielded'}>
              {sending}
            </Strip>
            <Main className='items-center gap-[26px] px-6 pt-[34px]'>
              <div className='relative flex h-[76px] w-[250px] shrink-0 items-center gap-3.5 border border-border-hard bg-elev-2 px-4'>
                <span className='flex h-[42px] w-[150px] flex-col justify-center gap-0.5 border border-border-soft bg-canvas px-2.5'>
                  <span className='text-[10px] text-fg-high'>review transaction</span>
                  <span className='truncate text-[9px] text-fg-muted'>
                    <Sensitive>{amount} zec</Sensitive> · {shortAddress(to)}
                  </span>
                </span>
                <span className='size-[22px] border-2 border-fg-muted' />
                <span className='absolute -right-[26px] top-8 h-2.5 w-[26px] bg-border-hard' />
              </div>
              <LedgerSteps
                phase={kind === 'ledger-shielded' ? (ledgerPhase ?? 'connecting') : undefined}
              />
            </Main>
            <Footer>
              <Button variant='secondary' onClick={handleBack} className='w-[110px]'>
                not now
              </Button>
              <Button disabled className='grow'>
                waiting for ledger
              </Button>
            </Footer>
          </>
        );

      case 'ledger-gone':
        return (
          <LedgerGone
            sending={sending}
            pool={recipientIsTransparent ? 'transparent · public' : 'shielded'}
            onCancel={handleBack}
            onReconnect={reconnectLedger}
          />
        );

      case 'complete': {
        const offerSave =
          showSavePrompt && !!recipient && !findByAddress(recipient) && !showContactModal;
        return (
          <>
            <Done
              line={
                kind && DEVICE[kind] ? (
                  `signed on ${device} · key never left it`
                ) : (
                  <>
                    <Sensitive>{amount} zec</Sensitive> to {toLabel}
                  </>
                )
              }
              txHash={txHash ?? undefined}
              onDone={handleClose}
            >
              {/* a cold device's offline view is stale after a send */}
              {kind && CAPS[kind].afterSend === 'sync-zigner' && (
                <Button
                  variant='secondary'
                  onClick={() => {
                    onClose();
                    navigate(PopupPath.NOTE_SYNC);
                  }}
                  className='px-3'
                >
                  sync zigner
                </Button>
              )}
              {offerSave && (
                <Button
                  variant='secondary'
                  onClick={() => setShowContactModal(true)}
                  className='px-3'
                >
                  save contact
                </Button>
              )}
              {txHash && (
                <Button
                  variant='secondary'
                  onClick={() =>
                    navigate(PopupPath.TX_DETAIL, {
                      state: {
                        network: 'zcash',
                        tx: {
                          id: txHash,
                          height: 0,
                          timestamp: null,
                          sentAt: Date.now(),
                          type: 'send',
                          description: 'sent',
                          amount,
                          memo,
                          feeAmount: fee,
                          recipient,
                          status: 'pending',
                        },
                      },
                    })
                  }
                  className='px-3'
                >
                  view transaction
                </Button>
              )}
            </Done>
            {showContactModal && (
              <SaveContactModal
                address={recipient}
                network='zcash'
                zcashme={
                  resolvedProfile?.address === to ? resolvedProfile : directoryProfileByAddress(to)
                }
                onDone={() => {
                  setShowContactModal(false);
                  setShowSavePrompt(false);
                }}
                onCancel={() => setShowContactModal(false)}
              />
            )}
          </>
        );
      }

      case 'frost-room':
      case 'frost-signing': {
        const ms = activeZcashWallet?.multisig;
        return (
          <>
            <ScreenHeader
              title='multisig signing'
              backPath={false}
              meta={ms && `${ms.threshold} of ${ms.maxSigners}`}
            />
            <Strip right={<Sensitive>fee {fee}</Sensitive>}>{sending}</Strip>
            <Main className='items-center justify-center gap-4'>
              {frostRoomCode && (
                <>
                  <span className='text-xs text-fg-muted'>share this code with co-signers</span>
                  <span className='border border-border-soft bg-elev-1 px-4 py-2 text-lg text-fg-high'>
                    {frostRoomCode}
                  </span>
                </>
              )}
              <span className='flex items-center gap-2 text-[13px] text-fg'>
                <Mark state='now' />
                {frostProgress}
              </span>
            </Main>
            <Footer>
              <Button variant='secondary' onClick={handleClose} className='w-full'>
                cancel
              </Button>
            </Footer>
          </>
        );
      }

      case 'airgap-flow':
        if (!pcztMultisigRef.current || !activeZcashWallet?.multisig) {
          return null;
        }
        return (
          <FrostAirgapSignFlow
            ms={activeZcashWallet.multisig}
            unsigned={pcztMultisigRef.current}
            recipient={to}
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
          <Stopped
            sending={sending}
            error={formError || signingError}
            onCancel={handleClose}
            onRetry={handleBack}
          />
        );

      default:
        return null;
    }
  };

  // A wallet with no signer here (a viewing key, a ledger with its signing
  // flag off) is told so instead of being offered a send it cannot sign.
  if (refusal) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center'>
        <span className={`${refusal.icon} size-6 text-fg-muted`} />
        <p className='text-sm text-fg-high lowercase'>{refusal.title}</p>
        <p className='text-xs text-fg-muted lowercase'>{refusal.body}</p>
        <Button variant='secondary' onClick={handleClose}>
          back
        </Button>
      </div>
    );
  }

  return (
    <div className='flex h-full flex-col bg-canvas'>
      {PasswordModal}
      {renderContent()}
    </div>
  );
}
