/**
 * Dedicated window for cosmos airgap signing via Zigner.
 * Opened from the send flow when a zigner wallet submits a cosmos transaction.
 * Flow: show QR → scan signature → broadcast → close
 */

import { useState, useCallback, useEffect } from 'react';
import { QrDisplay } from '../../shared/components/qr-display';
import { QrScanner } from '../../shared/components/qr-scanner';
import { Button } from '@repo/ui/components/ui/button';
import { parseCosmosSignatureQR, isCosmosSignatureQR } from '@repo/wallet/networks/cosmos/airgap';
import { useCosmosZignerBroadcast } from '../../hooks/cosmos-signer';
import type { CosmosZignerSignResult } from '../../hooks/cosmos-signer';

type Step = 'loading' | 'show-qr' | 'scan-qr' | 'broadcasting' | 'success' | 'error';

export const CosmosSign = () => {
  const [step, setStep] = useState<Step>('loading');
  const [signData, setSignData] = useState<CosmosZignerSignResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<string | undefined>();

  const cosmosZignerBroadcast = useCosmosZignerBroadcast();

  // Load pending sign data from session storage
  useEffect(() => {
    const load = async () => {
      try {
        const result = await chrome.storage.session.get('cosmosSignData');
        const raw = result['cosmosSignData'] as Record<string, unknown> | undefined;
        if (raw) {
          // Reconstitute Uint8Arrays that were converted to plain arrays for JSON storage
          const data: CosmosZignerSignResult = {
            ...raw,
            pubkey: new Uint8Array(raw['pubkey'] as number[]),
            signRequest: {
              ...(raw['signRequest'] as Record<string, unknown>),
              signDocBytes: new Uint8Array(
                (raw['signRequest'] as Record<string, unknown>)['signDocBytes'] as number[],
              ),
            },
          } as unknown as CosmosZignerSignResult;
          setSignData(data);
          setStep('show-qr');
        } else {
          setError('no pending cosmos sign request');
          setStep('error');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load sign data');
        setStep('error');
      }
    };
    void load();
  }, []);

  const handleScan = useCallback(async (hex: string) => {
    if (!isCosmosSignatureQR(hex)) {
      setError('invalid signature QR — expected 64-byte cosmos signature');
      setStep('error');
      return;
    }

    if (!signData) {
      setError('no pending sign request');
      setStep('error');
      return;
    }

    try {
      setStep('broadcasting');
      const signature = parseCosmosSignatureQR(hex);

      const result = await cosmosZignerBroadcast.mutateAsync({
        chainId: signData.chainId,
        signRequest: signData.signRequest,
        signature,
        pubkey: signData.pubkey,
      });

      // Clean up session storage
      await chrome.storage.session.remove('cosmosSignData');

      // Store result for the send page to pick up
      await chrome.storage.session.set({
        cosmosSignResult: { txHash: result.txHash, code: result.code },
      });

      setTxHash(result.txHash);
      setStep('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'broadcast failed');
      setStep('error');
    }
  }, [signData, cosmosZignerBroadcast]);

  const handleClose = () => {
    window.close();
  };

  // Loading
  if (step === 'loading') {
    return (
      <div className='flex h-screen items-center justify-center bg-background'>
        <p className='text-sm text-muted-foreground'>loading...</p>
      </div>
    );
  }

  // Show QR for Zigner to scan
  if (step === 'show-qr' && signData) {
    return (
      <div className='flex h-screen flex-col bg-background'>
        <div className='border-b border-gray-700 p-4'>
          <h1 className='bg-text-linear bg-clip-text pb-0 font-headline text-2xl font-bold text-transparent'>
            Sign with Zigner
          </h1>
        </div>

        <div className='grow overflow-auto p-4 flex flex-col items-center justify-center'>
          <QrDisplay
            data={signData.signRequestQr}
            size={840}
            title='Scan with Zigner'
            description='Open Zigner on your air-gapped device and scan this QR code to sign the transaction.'
            showCopy
          />
        </div>

        <div className='border-t border-gray-700 p-4 flex gap-3'>
          <Button
            variant='gradient'
            className='flex-1 py-3.5 text-base'
            size='lg'
            onClick={() => setStep('scan-qr')}
          >
            Scan Signed Response
          </Button>
          <Button
            variant='destructiveSecondary'
            className='flex-1 py-3.5 text-base'
            size='lg'
            onClick={handleClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Scan signature from Zigner
  if (step === 'scan-qr') {
    return (
      <div className='flex h-screen flex-col bg-background'>
        <QrScanner
          onScan={handleScan}
          onClose={() => setStep('show-qr')}
          title='Scan Signed QR'
          description='Scan the signed transaction QR code from Zigner'
        />
      </div>
    );
  }

  // Broadcasting
  if (step === 'broadcasting') {
    return (
      <div className='flex h-screen flex-col items-center justify-center bg-background gap-4'>
        <div className='animate-spin rounded-full h-8 w-8 border-2 border-zigner-gold border-t-transparent' />
        <p className='text-sm text-muted-foreground'>broadcasting transaction...</p>
      </div>
    );
  }

  // Success
  if (step === 'success') {
    return (
      <div className='flex h-screen flex-col items-center justify-center bg-background gap-4 p-6'>
        <div className='text-4xl'>✓</div>
        <p className='text-lg font-medium text-green-400'>Transaction Sent!</p>
        {txHash && (
          <p className='text-xs text-muted-foreground font-mono break-all text-center'>
            {txHash}
          </p>
        )}
        <Button variant='gradient' onClick={handleClose} className='mt-4'>
          Done
        </Button>
      </div>
    );
  }

  // Error
  return (
    <div className='flex h-screen flex-col items-center justify-center bg-background gap-4 p-6'>
      <p className='text-red-400 text-center'>{error}</p>
      <div className='flex gap-3'>
        <Button variant='gradient' onClick={() => {
          setError(undefined);
          setStep(signData ? 'show-qr' : 'loading');
        }}>
          Try Again
        </Button>
        <Button variant='destructiveSecondary' onClick={handleClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
};
