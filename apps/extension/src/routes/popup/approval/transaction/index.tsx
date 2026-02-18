import { useState } from 'react';
import { MetadataFetchFn, TransactionViewComponent } from '@repo/ui/components/ui/tx';
import { useStore } from '../../../../state';
import { txApprovalSelector } from '../../../../state/tx-approval';
import { JsonViewer } from '@repo/ui/components/ui/json-viewer';
import { AuthorizeRequest } from '@penumbra-zone/protobuf/penumbra/custody/v1/custody_pb';
import { TransactionPlan } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { useTransactionViewSwitcher } from './use-transaction-view-switcher';
import { ViewTabs } from './view-tabs';
import { ApproveDeny } from '../approve-deny';
import { UserChoice } from '@repo/storage-chrome/records';
import type { Jsonified } from '@rotko/penumbra-types/jsonified';
import { TransactionViewTab } from './types';
import { ChainRegistryClient } from '@penumbra-labs/registry';
import { viewClient } from '../../../../clients';
import { TransactionView } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { ConnectError } from '@connectrpc/connect';
import { encodePlanToQR, parseAuthorizationQR, validateAuthorization } from '@repo/wallet/airgap-signer';
import { QrDisplay } from '../../../../shared/components/qr-display';
import { QrScanner } from '../../../../shared/components/qr-scanner';
import { Button } from '@repo/ui/components/ui/button';

const getMetadata: MetadataFetchFn = async ({ assetId }) => {
  const feeAssetId = assetId ? assetId : new ChainRegistryClient().bundled.globals().stakingAssetId;

  const { denomMetadata } = await viewClient.assetMetadataById({ assetId: feeAssetId });
  return denomMetadata;
};

const hasAltGasFee = (txv?: TransactionView): boolean => {
  const { stakingAssetId } = new ChainRegistryClient().bundled.globals();
  const feeAssetId = txv?.bodyView?.transactionParameters?.fee?.assetId ?? stakingAssetId;

  return feeAssetId.equals(stakingAssetId);
};

const hasTransparentAddress = (txv?: TransactionView): boolean => {
  return (
    txv?.bodyView?.actionViews.some(
      action =>
        action.actionView.case === 'ics20Withdrawal' &&
        action.actionView.value.useTransparentAddress,
    ) ?? false
  );
};

type AirgapStep = 'review' | 'show-qr' | 'scan-qr';

export const TransactionApproval = () => {
  const {
    authorizeRequest,
    setChoice,
    sendResponse,
    invalidPlan,
    isAirgap,
    effectHash,
    setAuthorizationData,
  } = useStore(txApprovalSelector);

  const { selectedTransactionView, selectedTransactionViewName, setSelectedTransactionViewName } =
    useTransactionViewSwitcher();

  const [airgapStep, setAirgapStep] = useState<AirgapStep>('review');
  const [qrHex, setQrHex] = useState<string>('');
  const [scanError, setScanError] = useState<string | null>(null);

  if (!authorizeRequest?.plan || !selectedTransactionView) {
    return null;
  }

  const approve = () => {
    setChoice(UserChoice.Approved);
    sendResponse();
    window.close();
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    window.close();
  };

  const hexToBytes = (h: string): Uint8Array => {
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  };

  const startAirgapSigning = () => {
    if (!effectHash) {
      setScanError('Effect hash not available for airgap signing');
      return;
    }
    const plan = new TransactionPlan(authorizeRequest.plan);
    const hashBytes = hexToBytes(effectHash);
    const hex = encodePlanToQR(plan, hashBytes);
    setQrHex(hex);
    setAirgapStep('show-qr');
  };

  const handleAirgapScan = (hex: string) => {
    try {
      const authData = parseAuthorizationQR(hex);
      // Validate effect hash and signature counts match the plan
      const plan = new TransactionPlan(authorizeRequest.plan);
      const expectedHash = hexToBytes(effectHash!);
      validateAuthorization(plan, authData, expectedHash);
      setAuthorizationData(authData.toJson());
      setChoice(UserChoice.Approved);
      sendResponse();
      window.close();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Failed to parse QR code');
    }
  };

  // Airgap QR display step
  if (isAirgap && airgapStep === 'show-qr') {
    return (
      <div className='flex h-screen flex-col'>
        <div className='border-b border-gray-700 p-4'>
          <h1 className='bg-text-linear bg-clip-text pb-0 font-headline text-2xl font-bold text-transparent'>
            Sign with Zigner
          </h1>
        </div>

        <div className='grow overflow-auto p-4 flex flex-col items-center justify-center'>
          <QrDisplay
            data={qrHex}
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
            onClick={() => setAirgapStep('scan-qr')}
          >
            Scan Signed Response
          </Button>
          <Button
            variant='destructiveSecondary'
            className='flex-1 py-3.5 text-base'
            size='lg'
            onClick={deny}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Airgap QR scan step
  if (isAirgap && airgapStep === 'scan-qr') {
    return (
      <div className='flex h-screen flex-col'>
        {scanError ? (
          <div className='flex h-full flex-col items-center justify-center gap-4 p-6'>
            <p className='text-red-400 text-center'>{scanError}</p>
            <div className='flex gap-3'>
              <Button variant='gradient' onClick={() => setScanError(null)}>
                Try Again
              </Button>
              <Button variant='destructiveSecondary' onClick={deny}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <QrScanner
            onScan={handleAirgapScan}
            onClose={deny}
            title='Scan Signed QR'
            description='Scan the signed transaction QR code from Zigner'
          />
        )}
      </div>
    );
  }

  // Review step (shared between normal and airgap)
  return (
    <div className='flex h-screen flex-col'>
      <div className='border-b border-gray-700 p-4'>
        <h1 className=' bg-text-linear bg-clip-text pb-0 font-headline text-2xl font-bold text-transparent'>
          Confirm Transaction
        </h1>
      </div>

      <div className='grow overflow-auto p-4'>
        {invalidPlan && (
          <div className='mb-4 rounded border content-center border-red-500 p-2 text-sm text-red-500 text-center'>
            <h2>⚠ Invalid Transaction</h2>
            <p>
              {invalidPlan instanceof ConnectError ? invalidPlan.rawMessage : String(invalidPlan)}
            </p>
          </div>
        )}

        {selectedTransactionViewName === TransactionViewTab.SENDER && (
          <>
            {hasTransparentAddress(selectedTransactionView) && (
              <div className='mb-4 rounded border content-center border-yellow-500 p-2 text-sm text-yellow-500'>
                <h2>⚠ Privacy Warning</h2>
                <p>This transaction uses a transparent address which may reduce privacy.</p>
              </div>
            )}
            {!hasAltGasFee(selectedTransactionView) && (
              <div className='mb-4 rounded border content-center border-yellow-500 p-2 text-sm text-yellow-500'>
                <h2>⚠ Privacy Warning</h2>
                <p>
                  Transaction uses a non-native fee token. To reduce gas costs and protect your
                  privacy, maintain an UM balance for fees.
                </p>
              </div>
            )}
          </>
        )}

        <ViewTabs
          defaultValue={selectedTransactionViewName}
          onValueChange={setSelectedTransactionViewName}
        />

        <TransactionViewComponent txv={selectedTransactionView} metadataFetcher={getMetadata} />

        {selectedTransactionViewName === TransactionViewTab.SENDER && (
          <div className='mt-2'>
            <JsonViewer
              jsonObj={
                new AuthorizeRequest(authorizeRequest).toJson() as Jsonified<AuthorizeRequest>
              }
            />
          </div>
        )}
      </div>
      <div className='border-t border-gray-700 p-0'>
        {isAirgap ? (
          <div
            className='flex flex-row justify-between gap-4 rounded-md p-4 shadow-md'
            style={{ backgroundColor: '#1A1A1A', paddingBottom: '28px', paddingTop: '28px' }}
          >
            <Button
              variant='gradient'
              className='w-1/2 py-3.5 text-base'
              size='lg'
              onClick={invalidPlan ? undefined : startAirgapSigning}
              disabled={!!invalidPlan}
            >
              Sign with Zigner
            </Button>
            <Button
              className='w-1/2 py-3.5 text-base hover:bg-destructive/90'
              size='lg'
              variant='destructiveSecondary'
              onClick={deny}
            >
              Deny
            </Button>
          </div>
        ) : (
          <ApproveDeny approve={invalidPlan ? undefined : approve} deny={deny} wait={3} />
        )}
      </div>
    </div>
  );
};
