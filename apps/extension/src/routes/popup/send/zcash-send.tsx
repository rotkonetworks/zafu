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

import { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '../../../state';
import { zignerSigningSelector } from '../../../state/zigner-signing';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import {
  buildSendTxInWorker,
  completeSendTxInWorker,
  getBalanceInWorker,
  frostSignRound1InWorker,
  frostSpendSignInWorker,
  frostSpendAggregateInWorker,
  type SendTxUnsignedResult,
} from '../../../state/keyring/network-worker';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { RecipientPicker } from '../../../components/recipient-picker';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { usePasswordGate } from '../../../hooks/password-gate';
import {
  encodeZcashSignRequest,
  isZcashSignatureQR,
  parseZcashSignatureResponse,
  hexToBytes,
  bytesToHex,
} from '@repo/wallet/networks';

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

type SendStep = 'form' | 'review' | 'building' | 'sign' | 'scan' | 'broadcast' | 'complete' | 'error' | 'frost-room' | 'frost-signing';

/** live elapsed timer — ticks every second so the build screen never looks frozen */
function LiveTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startMs) return;
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return (
    <div className="font-mono text-2xl tabular-nums text-zigner-gold">
      {elapsed}s
    </div>
  );
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

  const [step, setStep] = useState<SendStep>('form');
  const [recipient, setRecipient] = useState(prefill?.recipient ?? '');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [memo, setMemo] = useState(prefill?.memo ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [fee, setFee] = useState('0.0001');
  const [showContacts, setShowContacts] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const unsignedTxRef = useRef<SendTxUnsignedResult | null>(null);
  const [sendSteps, setSendSteps] = useState<Array<{ step: string; detail?: string; elapsedMs: number }>>([]);
  const [totalElapsedSec, setTotalElapsedSec] = useState<number | null>(null);
  const buildStartRef = useRef<number>(0);

  // FROST multisig state
  const [frostRoomCode, setFrostRoomCode] = useState('');
  const [frostProgress, setFrostProgress] = useState('');

  // store access for wallet id and server url
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const ufvk = activeZcashWallet?.ufvk ?? (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);


  // fetch spendable balance on mount
  const [balanceZat, setBalanceZat] = useState<bigint | null>(null);
  useEffect(() => {
    if (!selectedKeyInfo) return;
    getBalanceInWorker('zcash', selectedKeyInfo.id)
      .then(bal => setBalanceZat(BigInt(bal)))
      .catch(() => {}); // worker not ready
  }, [selectedKeyInfo?.id]);

  const balanceZec = balanceZat !== null ? Number(balanceZat) / 1e8 : null;
  const FEE_ZAT = 10_000n; // standard 0.0001 ZEC fee
  const maxSendZec = balanceZat !== null && balanceZat > FEE_ZAT
    ? Number(balanceZat - FEE_ZAT) / 1e8
    : 0;

  // listen for send progress events from worker
  useEffect(() => {
    if (step !== 'building' && step !== 'broadcast') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { step: string; detail?: string; elapsedMs: number };
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
    const validPrefix = r.startsWith('u1') || r.startsWith('utest1')
      || r.startsWith('t1') || r.startsWith('t3');
    if (!validPrefix) {
      setFormError('invalid zcash address - expected unified (u1) or transparent (t1/t3). sapling (zs) is not supported.');
      return false;
    }
    if (!amount.trim() || isNaN(Number(amount)) || Number(amount) <= 0) {
      setFormError('enter a valid amount');
      return false;
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
    let frostAbort: AbortController | null = null;
    if (!selectedKeyInfo) {
      setFormError('no wallet selected');
      return;
    }

    setStep('building');
    setFormError(null);
    setSendSteps([]);
    buildStartRef.current = Date.now();

    try {
      const walletId = selectedKeyInfo.id;
      const amountZat = Math.round(Number(amount) * 1e8).toString();

      if (selectedKeyInfo.type === 'mnemonic') {
        // mnemonic wallet: verify password, then build signed tx + broadcast
        const authorized = await requestAuth();
        if (!authorized) { setStep('review'); return; }
        const mnemonic = await getMnemonic(walletId);
        const result = await buildSendTxInWorker(
          'zcash', walletId, zidecarUrl, recipient.trim(), amountZat, memo,
          accountIndex, mainnet, mnemonic,
        );

        if ('txid' in result) {
          const feeZec = (Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
          setFee(feeZec);
          complete(result.txid);
          setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
          setStep('complete');
          void recordUsage(recipient, 'zcash');
          if (shouldSuggestSave(recipient)) {
            setShowSavePrompt(true);
          }
        }
      } else if (activeZcashWallet?.multisig) {
        // ── FROST multisig: build unsigned tx → relay signing rounds ──
        const ms = activeZcashWallet.multisig;
        // decrypt secret key material from vault
        const secrets = await useStore.getState().keyRing.getMultisigSecrets(activeZcashWallet.vaultId);
        if (!secrets) throw new Error('failed to decrypt multisig keys — unlock wallet first');
        const result = await buildSendTxInWorker(
          'zcash', walletId, zidecarUrl, recipient.trim(), amountZat, memo, accountIndex, mainnet,
          undefined, ufvk,
        );

        if (!('sighash' in result)) {
          throw new Error('unexpected result from unsigned tx build');
        }

        unsignedTxRef.current = result;
        const feeZec = (Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setFee(feeZec);

        // create relay room for signing session
        setStep('frost-room');
        const relayUrl = ms.relayUrl || 'https://poker.zk.bot';
        const relay = new FrostRelayClient(relayUrl);
        const room = await relay.createRoom(ms.threshold, ms.maxSigners, 300);
        setFrostRoomCode(room.roomCode);

        // signing: generate fresh nonces per action to prevent nonce reuse
        setStep('frost-signing');
        setFrostProgress('round 1: generating commitments...');

        const numActions = result.alphas.length;

        // generate one round1 (nonces + commitments) per action
        const round1s: { nonces: string; commitments: string }[] = [];
        for (let i = 0; i < numActions; i++) {
          round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
        }

        // join room and set up message collection
        const participantId = new Uint8Array(32);
        crypto.getRandomValues(participantId);

        // per-action commitment and share collection from peers
        const peerCommitmentsPerAction: string[][] = Array.from({ length: numActions }, () => []);
        const peerSharesPerAction: string[][] = Array.from({ length: numActions }, () => []);
        let signingPhase: 'commitments' | 'shares' | 'done' = 'commitments';

        const abortController = frostAbort = new AbortController();
        void relay.joinRoom(room.roomCode, participantId, (event) => {
          if (event.type === 'message') {
            const text = new TextDecoder().decode(event.message.payload);
            if (text.startsWith('SIGN:')) return; // skip echoed SIGN prefix
            if (signingPhase === 'commitments') {
              // peers send pipe-delimited commitments for all actions
              const parts = text.split('|');
              for (let i = 0; i < parts.length && i < numActions; i++) {
                peerCommitmentsPerAction[i]!.push(parts[i]!);
              }
            } else if (signingPhase === 'shares') {
              // shares are tagged: S:<actionIndex>:<shareData>
              const shareMatch = text.match(/^S:(\d+):(.+)$/);
              if (shareMatch) {
                const actionIdx = Number(shareMatch[1]);
                if (actionIdx >= 0 && actionIdx < numActions) {
                  peerSharesPerAction[actionIdx]!.push(shareMatch[2]!);
                }
              }
            }
          }
        }, abortController.signal);

        // broadcast SIGN prefix with tx summary so co-signers can verify
        const amountZec = (Number(amountZat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        const summary = `${amountZec} ZEC to ${recipient.trim().slice(0, 16)}...`;
        const signPrefix = `SIGN:${result.sighash}:${result.alphas.join(',')}:${summary}`;
        await relay.sendMessage(room.roomCode, participantId, new TextEncoder().encode(signPrefix));
        const ourCommitments = round1s.map(r => r.commitments).join('|');
        await relay.sendMessage(room.roomCode, participantId, new TextEncoder().encode(ourCommitments));

        // wait for threshold-1 peer commitment bundles
        setFrostProgress(`round 1: waiting for ${ms.threshold - 1} co-signer(s)...`);
        await waitFor(() => peerCommitmentsPerAction[0]!.length >= ms.threshold - 1, 120000);

        // round 2: sign each action with its own nonces
        signingPhase = 'shares';
        setFrostProgress('round 2: signing...');

        const orchardSigs: string[] = [];
        for (let i = 0; i < numActions; i++) {
          const allCommitments = [round1s[i]!.commitments, ...peerCommitmentsPerAction[i]!];

          const share = await frostSpendSignInWorker(
            secrets.keyPackage, round1s[i]!.nonces, result.sighash, result.alphas[i]!, allCommitments,
          );
          // tag share with action index so peers can bucket correctly
          await relay.sendMessage(room.roomCode, participantId, new TextEncoder().encode(`S:${i}:${share}`));

          setFrostProgress(`round 2: collecting shares (${i + 1}/${numActions})...`);
          await waitFor(() => peerSharesPerAction[i]!.length >= ms.threshold - 1, 120000);

          const allSharesForAction = [share, ...peerSharesPerAction[i]!];
          const sig = await frostSpendAggregateInWorker(
            ms.publicKeyPackage, result.sighash, result.alphas[i]!, allCommitments, allSharesForAction,
          );
          orchardSigs.push(sig);
        }

        signingPhase = 'done';
        abortController.abort();

        // complete transaction with aggregated signatures
        setStep('broadcast');
        setFrostProgress('broadcasting...');
        const finalResult = await completeSendTxInWorker(
          'zcash', walletId, zidecarUrl,
          result.unsignedTx,
          { orchardSigs, transparentSigs: [] },
          result.spendIndices,
        );

        complete(finalResult.txid);
        setTotalElapsedSec(Math.round((Date.now() - buildStartRef.current) / 1000));
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      } else {
        // zigner wallet: build unsigned tx → QR signing flow
        const result = await buildSendTxInWorker(
          'zcash', walletId, zidecarUrl, recipient.trim(), amountZat, memo, accountIndex, mainnet,
          undefined, ufvk,
        );

        if (!('sighash' in result)) {
          throw new Error('unexpected result from unsigned tx build');
        }

        unsignedTxRef.current = result;
        const feeZec = (Number(result.fee) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setFee(feeZec);

        const sighashBytes = hexToBytes(result.sighash);
        const alphaBytes = result.alphas.map(a => hexToBytes(a));

        const signRequest = encodeZcashSignRequest({
          accountIndex,
          sighash: sighashBytes,
          orchardAlphas: alphaBytes,
          summary: result.summary || `send ${amount} zec to ${recipient.slice(0, 20)}...`,
          mainnet,
        });

        setSignRequestQr(signRequest);

        startSigning({
          id: `zcash-${Date.now()}`,
          network: 'zcash',
          summary: `send ${amount} zec`,
          signRequestQr: signRequest,
          recipient,
          amount,
          fee: feeZec,
          createdAt: Date.now(),
        });

        setStep('sign');
      }
    } catch (err) {
      frostAbort?.abort();
      setFormError(err instanceof Error ? err.message : 'failed to build transaction');
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
        setError('invalid signature qr code');
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
          'zcash', selectedKeyInfo.id, zidecarUrl,
          unsignedTxRef.current.unsignedTx, signatures,
          unsignedTxRef.current.spendIndices,
        );

        unsignedTxRef.current = null;
        complete(result.txid);
        setStep('complete');
        void recordUsage(recipient, 'zcash');
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
      } catch (err) {
        unsignedTxRef.current = null;
        setError(err instanceof Error ? err.message : 'failed to broadcast transaction');
        setStep('error');
      }
    },
    [processSignature, complete, setError, selectedKeyInfo, zidecarUrl, recipient, recordUsage, shouldSuggestSave]
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
      case 'frost-room':
      case 'frost-signing':
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
    reset();
    onClose();
  };

  // render based on current step
  const renderContent = () => {
    switch (step) {
      case 'form':
        return (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="text-fg-muted hover:text-fg-high transition-colors"
              >
                <span className="i-lucide-arrow-left h-5 w-5" />
              </button>
              <h2 className="text-lg font-medium">send zcash</h2>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label className="mb-1 block text-xs text-fg-muted">
                  recipient address
                </label>
                <div className="flex gap-1">
                  <input
                    type="text"
                    placeholder="u1... / zs... / t1..."
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    className="flex-1 rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowQrScanner(true)}
                    className="shrink-0 flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-border-soft bg-input text-fg-muted hover:text-fg-high transition-colors"
                    title="scan QR code"
                  >
                    <span className="i-lucide-scan h-4 w-4" />
                  </button>
                </div>
                {showQrScanner && (
                  <QrScanner
                    onScan={(data) => {
                      const addr = data.startsWith('zcash:') ? data.slice(6).split('?')[0]! : data;
                      setRecipient(addr);
                      setShowQrScanner(false);
                    }}
                    onClose={() => setShowQrScanner(false)}
                    title="scan address"
                    description="scan a zcash address QR code"
                    inline
                  />
                )}
                <RecipientPicker
                  network='zcash'
                  onSelect={(addr) => { setRecipient(addr); setShowContacts(false); }}
                  show={!recipient}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-fg-muted">
                    amount (zec)
                  </label>
                  {balanceZec !== null && (
                    <span className="text-xs text-fg-muted tabular-nums">
                      balance: {balanceZec.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} ZEC
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  <input
                    type="number"
                    placeholder="0.0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    step="0.0001"
                    min="0"
                    className="flex-1 rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setAmount(maxSendZec > 0 ? maxSendZec.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0')}
                    disabled={maxSendZec <= 0}
                    className="shrink-0 h-[42px] rounded-lg border border-border-soft bg-input px-3 text-xs text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50"
                  >
                    max
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-fg-muted">
                  memo (optional)
                </label>
                <input
                  type="text"
                  placeholder="private message"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={512}
                  className="w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors focus:border-zigner-gold focus:outline-none"
                />
              </div>

              {formError && (
                <p className="text-sm text-red-400">{formError}</p>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <button onClick={handleClose} className="flex-1 rounded-lg border border-border-soft bg-input py-2.5 text-sm text-fg-muted hover:text-fg-high transition-colors">
                cancel
              </button>
              <button onClick={handleReview} className="flex-1 rounded-lg bg-zigner-gold py-2.5 text-sm font-medium text-zigner-dark hover:bg-primary/90 transition-colors">
                continue
              </button>
            </div>
          </div>
        );

      case 'review':
        return (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <button onClick={handleBack} className="text-fg-muted hover:text-fg-high transition-colors">
                <span className="i-lucide-arrow-left w-5 h-5" />
              </button>
              <h2 className="text-lg font-medium">review transaction</h2>
            </div>

            <div className="bg-elev-1 border border-border-soft rounded-lg p-4 flex flex-col gap-3">
              <div className="flex justify-between">
                <span className="text-fg-muted">network</span>
                <span className="font-medium">
                  zcash {mainnet ? 'mainnet' : 'testnet'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-muted">to</span>
                <span className="font-mono text-sm truncate max-w-[180px]">
                  {recipient}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-muted">amount</span>
                <span className="font-medium">{amount} zec</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-muted">fee</span>
                <span className="text-sm">{fee} zec</span>
              </div>
              <div className="border-t border-border-soft pt-2 flex justify-between">
                <span className="text-fg-muted">total</span>
                <span className="font-medium">
                  {(Number(amount) + Number(fee)).toFixed(4)} zec
                </span>
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={handleBack} className="flex-1">
                back
              </Button>
              <Button variant="gradient" onClick={() => void handleSign()} className="flex-1">
                {selectedKeyInfo?.type === 'mnemonic' ? 'sign & send' : 'sign with zafu zigner'}
              </Button>
            </div>
          </div>
        );

      case 'building':
        return (
          <div className="flex flex-col items-center gap-4 p-6">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin" />
            </div>
            <h2 className="text-lg font-medium">building transaction</h2>

            {/* live elapsed timer — ticks every second so the UI never looks frozen */}
            <LiveTimer startMs={buildStartRef.current} />

            {sendSteps.length > 0 ? (
              <div className="w-full max-w-sm flex flex-col gap-1">
                {sendSteps.map((s, i) => {
                  const isLast = i === sendSteps.length - 1;
                  const prevMs = i > 0 ? sendSteps[i - 1]!.elapsedMs : 0;
                  const stepDuration = ((s.elapsedMs - prevMs) / 1000).toFixed(1);
                  return (
                    <div key={i} className={`flex items-start gap-2 text-xs ${isLast ? 'text-fg' : 'text-fg-muted'}`}>
                      <span className="font-mono w-12 text-right shrink-0">
                        {(s.elapsedMs / 1000).toFixed(1)}s
                      </span>
                      <span className={isLast ? '' : ''}>
                        {s.step}
                        {s.detail && <span className="text-fg-muted ml-1">({s.detail})</span>}
                        {!isLast && Number(stepDuration) >= 0.5 && (
                          <span className="text-fg-muted ml-1">+{stepDuration}s</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-fg-muted text-center">
                preparing...
              </p>
            )}
          </div>
        );

      case 'sign':
        return (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <button onClick={handleBack} className="text-fg-muted hover:text-fg-high transition-colors">
                <span className="i-lucide-arrow-left w-5 h-5" />
              </button>
<h2 className="text-lg font-medium">sign with zafu zigner</h2>
            </div>

            <div className="flex flex-col items-center gap-4 py-4">
              {signRequestQr && (
                <QrDisplay
                  data={signRequestQr}
                  size={220}
title="scan with zafu zigner"
                  description="open zafu zigner camera and scan this qr code to sign the transaction"
                />
              )}

              <div className="text-center">
                <p className="text-sm text-fg-muted">
1. open zafu zigner app on your phone
                </p>
                <p className="text-sm text-fg-muted">
                  2. scan this qr code
                </p>
                <p className="text-sm text-fg-muted">
                  3. review and approve the transaction
                </p>
              </div>
            </div>

            <Button variant="gradient" onClick={handleScanSignature} className="w-full">
scan signature from zafu zigner
            </Button>
          </div>
        );

      case 'scan':
        return (
          <QrScanner
            onScan={handleSignatureScanned}
            onError={(err) => {
              setError(err);
              setStep('error');
            }}
            onClose={() => setStep('sign')}
            title="scan signature"
description="point camera at zafu zigner's signature qr code"
          />
        );

      case 'broadcast':
        return (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-pulse">
              <div className="w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin" />
            </div>
            <h2 className="text-lg font-medium">broadcasting transaction</h2>
            <p className="text-sm text-fg-muted text-center">
              sending your transaction to the zcash network...
            </p>
          </div>
        );

      case 'complete':
        return (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
              <span className="i-lucide-check w-8 h-8 text-green-400" />
            </div>
            <h2 className="text-lg font-medium">transaction sent!</h2>
            <p className="text-sm text-fg-muted text-center">
              {amount} zec sent successfully
              {totalElapsedSec !== null && ` in ${totalElapsedSec}s`}
            </p>
            {txHash && (
              <p className="font-mono text-xs text-fg-muted break-all">
                {txHash}
              </p>
            )}

            {/* save contact prompt */}
            {showSavePrompt && recipient && !findByAddress(recipient) && !showContactModal && (
              <div className="w-full rounded-lg border border-primary/40 bg-primary/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="i-lucide-user h-4 w-4 text-zigner-gold" />
                  <p className="text-sm">save to contacts?</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowContactModal(true)}
                    className="flex-1 rounded-lg bg-zigner-gold py-2 text-xs font-medium text-zigner-dark hover:bg-primary/90 transition-colors"
                  >
                    save
                  </button>
                  <button
                    onClick={() => {
                      void dismissSuggestion(recipient);
                      setShowSavePrompt(false);
                    }}
                    className="flex-1 rounded-lg border border-border-soft py-2 text-xs text-fg-muted hover:text-fg-high transition-colors"
                  >
                    skip
                  </button>
                </div>
              </div>
            )}

            {showContactModal && (
              <SaveContactModal
                address={recipient}
                network='zcash'
                onDone={() => { setShowContactModal(false); setShowSavePrompt(false); }}
                onCancel={() => setShowContactModal(false)}
              />
            )}

            <Button variant="gradient" onClick={handleClose} className="w-full mt-4">
              done
            </Button>
          </div>
        );

      case 'frost-room':
      case 'frost-signing':
        return (
          <div className="flex flex-col items-center gap-6 p-8">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="i-lucide-users w-8 h-8 text-zigner-gold" />
            </div>
            <h2 className="text-lg font-medium">multisig signing</h2>

            {frostRoomCode && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-fg-muted">share this code with co-signers:</p>
                <div className="rounded bg-elev-2 px-4 py-2 font-mono text-lg">{frostRoomCode}</div>
              </div>
            )}

            <div className="flex flex-col items-center gap-2">
              <p className="text-sm">{frostProgress}</p>
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zigner-gold border-t-transparent" />
            </div>

            <div className="w-full rounded bg-elev-2 p-3 text-xs text-fg-muted">
              <p>{activeZcashWallet?.multisig?.threshold}-of-{activeZcashWallet?.multisig?.maxSigners} threshold</p>
              <p className="mt-1">send {amount} ZEC to {recipient.slice(0, 16)}...{recipient.slice(-8)}</p>
              <p className="mt-1">fee: {fee} ZEC</p>
            </div>

            <Button variant="secondary" onClick={handleClose} className="w-full mt-2">
              cancel
            </Button>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="i-lucide-x w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-lg font-medium">transaction failed</h2>
            <p className="text-sm text-red-400 text-center">
              {formError || signingError || 'an error occurred'}
            </p>
            <div className="flex gap-2 w-full mt-4">
              <Button variant="secondary" onClick={handleClose} className="flex-1">
                cancel
              </Button>
              <Button variant="gradient" onClick={handleBack} className="flex-1">
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
    <div className="h-full bg-canvas">
      {PasswordModal}
      {renderContent()}
    </div>
  );
}

/** poll until condition is true, with timeout */
const waitFor = (condition: () => boolean, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for co-signers'));
      setTimeout(check, 500);
    };
    check();
  });
