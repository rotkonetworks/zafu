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

import { useState, useCallback, useMemo } from 'react';
import { useStore } from '../../../state';
import { zignerSigningSelector } from '../../../state/zigner-signing';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { ArrowLeftIcon, CheckIcon, Cross1Icon, PersonIcon } from '@radix-ui/react-icons';
import {
  encodeZcashSignRequest,
  isZcashSignatureQR,
  parseZcashSignatureResponse,
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

type SendStep = 'form' | 'review' | 'sign' | 'scan' | 'broadcast' | 'complete' | 'error';

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
  const { recordUsage, shouldSuggestSave, dismissSuggestion, getRecent } = useStore(recentAddressesSelector);
  const { addContact, addAddress, findByAddress } = useStore(contactsSelector);

  const [step, setStep] = useState<SendStep>('form');
  const [recipient, setRecipient] = useState(prefill?.recipient ?? '');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [memo, setMemo] = useState(prefill?.memo ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [contactName, setContactName] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);

  // get recent zcash addresses
  const recentAddresses = useMemo(() => getRecent('zcash', 3), [getRecent]);

  // mock fee for now
  const fee = '0.0001';

  const validateForm = (): boolean => {
    if (!recipient.trim()) {
      setFormError('recipient address is required');
      return false;
    }
    if (!recipient.startsWith('u1') && !recipient.startsWith('u')) {
      setFormError('invalid unified address format');
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

  const handleSign = () => {
    // create sign request qr
    // in real implementation, this would:
    // 1. fetch spendable notes
    // 2. build unsigned transaction
    // 3. compute sighash and alphas
    // for now, create a mock sign request

    const mockSighash = new Uint8Array(32).fill(0x42);
    const mockAlpha = new Uint8Array(32).fill(0x13);

    const signRequest = encodeZcashSignRequest({
      accountIndex,
      sighash: mockSighash,
      orchardAlphas: [mockAlpha],
      summary: `send ${amount} zec to ${recipient.slice(0, 20)}...`,
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
      fee,
      createdAt: Date.now(),
    });

    setStep('sign');
  };

  const handleScanSignature = () => {
    setStep('scan');
    startScanning();
  };

  const handleSignatureScanned = useCallback(
    (data: string) => {
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

        // simulate broadcast
        setTimeout(() => {
          const mockTxHash = 'zcash_tx_' + Math.random().toString(36).substring(2, 15);
          complete(mockTxHash);
          setStep('complete');
          // record address usage
          void recordUsage(recipient, 'zcash');
          // check if we should prompt to save as contact
          if (shouldSuggestSave(recipient)) {
            setShowSavePrompt(true);
          }
        }, 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to parse signature');
        setStep('error');
      }
    },
    [processSignature, complete, setError]
  );

  const handleBack = () => {
    switch (step) {
      case 'review':
        setStep('form');
        break;
      case 'sign':
        setStep('review');
        break;
      case 'scan':
        setStep('sign');
        break;
      case 'error':
        setStep('sign');
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
            <h2 className="text-xl font-bold">send zcash</h2>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">
                  recipient address
                </label>
                <Input
                  placeholder="u1..."
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className="font-mono text-sm"
                />
                {/* recent addresses */}
                {!recipient && recentAddresses.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-muted-foreground mb-1">recent:</p>
                    <div className="flex flex-wrap gap-1">
                      {recentAddresses.map(r => {
                        const result = findByAddress(r.address);
                        return (
                          <button
                            key={r.address}
                            onClick={() => setRecipient(r.address)}
                            className="rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                          >
                            {result ? result.contact.name : `${r.address.slice(0, 8)}...${r.address.slice(-4)}`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-1 block">
                  amount (zec)
                </label>
                <Input
                  type="number"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  step="0.0001"
                  min="0"
                />
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-1 block">
                  memo (optional)
                </label>
                <Input
                  placeholder="private message"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  maxLength={512}
                />
              </div>

              {formError && (
                <p className="text-sm text-red-400">{formError}</p>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={handleClose} className="flex-1">
                cancel
              </Button>
              <Button variant="gradient" onClick={handleReview} className="flex-1">
                continue
              </Button>
            </div>
          </div>
        );

      case 'review':
        return (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <button onClick={handleBack} className="p-1 hover:bg-muted rounded">
                <ArrowLeftIcon className="w-5 h-5" />
              </button>
              <h2 className="text-xl font-bold">review transaction</h2>
            </div>

            <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">network</span>
                <span className="font-medium">
                  zcash {mainnet ? 'mainnet' : 'testnet'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">to</span>
                <span className="font-mono text-sm truncate max-w-[180px]">
                  {recipient}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">amount</span>
                <span className="font-medium">{amount} zec</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">fee</span>
                <span className="text-sm">{fee} zec</span>
              </div>
              <div className="border-t border-border pt-2 flex justify-between">
                <span className="text-muted-foreground">total</span>
                <span className="font-bold">
                  {(Number(amount) + Number(fee)).toFixed(4)} zec
                </span>
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={handleBack} className="flex-1">
                back
              </Button>
              <Button variant="gradient" onClick={handleSign} className="flex-1">
sign with zafu zigner
              </Button>
            </div>
          </div>
        );

      case 'sign':
        return (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
              <button onClick={handleBack} className="p-1 hover:bg-muted rounded">
                <ArrowLeftIcon className="w-5 h-5" />
              </button>
<h2 className="text-xl font-bold">sign with zafu zigner</h2>
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
                <p className="text-sm text-muted-foreground">
1. open zafu zigner app on your phone
                </p>
                <p className="text-sm text-muted-foreground">
                  2. scan this qr code
                </p>
                <p className="text-sm text-muted-foreground">
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
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
            <h2 className="text-xl font-bold">broadcasting transaction</h2>
            <p className="text-sm text-muted-foreground text-center">
              sending your transaction to the zcash network...
            </p>
          </div>
        );

      case 'complete':
        return (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
              <CheckIcon className="w-8 h-8 text-green-500" />
            </div>
            <h2 className="text-xl font-bold">transaction sent!</h2>
            <p className="text-sm text-muted-foreground text-center">
              {amount} zec sent successfully
            </p>
            {txHash && (
              <p className="font-mono text-xs text-muted-foreground break-all">
                {txHash}
              </p>
            )}

            {/* save contact prompt */}
            {showSavePrompt && recipient && !findByAddress(recipient) && !showContactModal && (
              <div className="w-full rounded-lg border border-primary/30 bg-primary/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <PersonIcon className="h-4 w-4 text-primary" />
                  <p className="text-sm">save to contacts?</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="gradient"
                    size="sm"
                    onClick={() => setShowContactModal(true)}
                    className="flex-1"
                  >
                    save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void dismissSuggestion(recipient);
                      setShowSavePrompt(false);
                    }}
                    className="flex-1"
                  >
                    skip
                  </Button>
                </div>
              </div>
            )}

            {/* contact name input */}
            {showContactModal && (
              <div className="w-full rounded-lg border border-border bg-card p-3">
                <p className="text-sm font-medium mb-2">name this contact</p>
                <Input
                  value={contactName}
                  onChange={e => setContactName(e.target.value)}
                  placeholder="enter name..."
                  className="mb-2"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    variant="gradient"
                    size="sm"
                    onClick={async () => {
                      if (contactName.trim()) {
                        const newContact = await addContact({ name: contactName.trim() });
                        await addAddress(newContact.id, { network: 'zcash', address: recipient });
                        setShowContactModal(false);
                        setShowSavePrompt(false);
                        setContactName('');
                      }
                    }}
                    disabled={!contactName.trim()}
                    className="flex-1"
                  >
                    save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setShowContactModal(false);
                      setContactName('');
                    }}
                    className="flex-1"
                  >
                    cancel
                  </Button>
                </div>
              </div>
            )}

            <Button variant="gradient" onClick={handleClose} className="w-full mt-4">
              done
            </Button>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <Cross1Icon className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-bold">transaction failed</h2>
            <p className="text-sm text-red-400 text-center">
              {signingError || 'an error occurred'}
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
    <div className="h-full bg-background">
      {renderContent()}
    </div>
  );
}
