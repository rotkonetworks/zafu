import { useState } from 'react';
import { MetadataFetchFn, TransactionViewComponent } from '@repo/ui/components/ui/tx';
import { exitApprovalSurface, usePopupNav } from '../../../../utils/navigate';
import { Sensitive } from '../../../../components/sensitive';
import { useStore } from '../../../../state';
import { txApprovalSelector } from '../../../../state/tx-approval';
import { PasswordGateModal } from '../../../../shared/components/password-gate';
import { JsonViewer } from '@repo/ui/components/ui/json-viewer';
import { AuthorizeRequest } from '@penumbra-zone/protobuf/penumbra/custody/v1/custody_pb';
import { TransactionPlan } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { useTransactionViewSwitcher } from './use-transaction-view-switcher';
import { ViewTabs } from './view-tabs';
import { ApproveDeny } from '../approve-deny';
import { UserChoice } from '@repo/storage-chrome/records';
import type { Jsonified } from '@rotko/penumbra-types/jsonified';
import { TransactionViewTab } from './types';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { viewClient } from '../../../../clients';
import { TransactionView } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { ConnectError } from '@connectrpc/connect';
import {
  encodePlanToQR,
  parseAuthorizationQR,
  validateAuthorization,
} from '@repo/wallet/airgap-signer';
import { QrDisplay } from '../../../../shared/components/qr-display';
import { zignerCodeChain } from '../../../../shared/zigner-code';
import { QrScanner } from '../../../../shared/components/qr-scanner';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { ScreenHeader } from '../../../../components/screen-header';
import { Footer, Main } from '../../send/send-ui';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { selectTxSigningSecurity } from '../../../../state/privacy';
import {
  approvalWaitSeconds,
  opensGraceWindow,
  shouldPromptPassword,
  SIGN_GRACE_MS,
} from '../../../../shared/tx-signing-security';

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

  const txSigningSecurity = useStore(selectTxSigningSecurity);
  const navigate = usePopupNav();

  const [airgapStep, setAirgapStep] = useState<AirgapStep>('review');
  const [qrHex, setQrHex] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [showPasswordGate, setShowPasswordGate] = useState(false);
  const [showJson, setShowJson] = useState(false);

  if (!authorizeRequest?.plan || !selectedTransactionView) {
    return null;
  }

  // After responding, a toolbar popup or dedicated window should close, but the
  // side panel must NOT - closing it tears down the panel the user deliberately
  // pinned open (the reported "sidebar closes after a penumbra tx like a popup
  // did"). `exitApprovalSurface` returns to the wallet home in that context.
  const finish = () => {
    exitApprovalSurface(navigate);
  };

  const approve = () => {
    setChoice(UserChoice.Approved);
    sendResponse();
    finish();
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    finish();
  };

  // Decide whether the per-tx password gate is required based on the signing
  // security level. Skipping it is safe: while unlocked, signing is authorized
  // by the session `passwordKey` (state/keyring/crypto-ops.ts `requireKey`), not
  // by a freshly-typed password. The gate is a second confirmation, so approve()
  // succeeds without it. Reads signGraceUntil at click time.
  const requestApproval = async () => {
    const signGraceUntil = await sessionExtStorage.get('signGraceUntil');
    if (shouldPromptPassword(txSigningSecurity, Date.now(), signGraceUntil)) {
      setShowPasswordGate(true);
    } else {
      approve();
    }
  };

  // Called after a successful password gate. Under 'grace', open the 15-minute
  // window so the next txs skip the gate; the window is cleared whenever the
  // wallet locks (see session signGraceUntil clear sites).
  const onGateConfirmed = () => {
    setShowPasswordGate(false);
    if (opensGraceWindow(txSigningSecurity)) {
      void sessionExtStorage.set('signGraceUntil', Date.now() + SIGN_GRACE_MS);
    }
    approve();
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
      setScanError("this request can't be shown to zigner · nothing was signed");
      return;
    }
    const plan = new TransactionPlan(authorizeRequest.plan);
    const hashBytes = hexToBytes(effectHash);
    const hex = encodePlanToQR(plan, hashBytes);
    setQrHex(hex);
    setAirgapStep('show-qr');
  };

  const handleAirgapScan = (hex: string) => {
    if (zignerCodeChain(hex) === 'zcash') {
      setScanError("this code is zigner's zcash code. this request needs its penumbra code.");
      return;
    }
    try {
      const authData = parseAuthorizationQR(hex);
      // Validate effect hash and signature counts match the plan
      const plan = new TransactionPlan(authorizeRequest.plan);
      const expectedHash = hexToBytes(effectHash!);
      validateAuthorization(plan, authData, expectedHash);
      setAuthorizationData(authData.toJson());
      setChoice(UserChoice.Approved);
      sendResponse();
      finish();
    } catch (e) {
      setScanError(
        e instanceof Error ? e.message : "that code isn't zigner's answer · please scan again",
      );
    }
  };

  // airgap: show the plan to zigner, then read its answer back
  if (isAirgap && airgapStep === 'show-qr') {
    return (
      <div className='flex h-full min-h-0 flex-col bg-canvas'>
        <ScreenHeader title='sign on zigner' onBack={() => setAirgapStep('review')} meta='1 / 2' />
        <Main className='items-center gap-4 px-5 pt-6'>
          <QrDisplay data={qrHex} size={300} showCopy />
          <span className='text-[13px] text-fg-high'>scan this with zigner, approve there</span>
        </Main>
        <Footer>
          <Button variant='secondary' onClick={deny} className='w-[110px]'>
            don&apos;t sign
          </Button>
          <Button onClick={() => setAirgapStep('scan-qr')} className='grow'>
            scan zigner&apos;s answer
          </Button>
        </Footer>
      </div>
    );
  }

  if (isAirgap && airgapStep === 'scan-qr') {
    return scanError ? (
      <div className='flex h-full min-h-0 flex-col bg-canvas'>
        <ScreenHeader title='sign on zigner' onBack={() => setScanError(null)} meta='2 / 2' />
        <Main className='pt-5'>
          <StatusSlot tone='warn' icon='i-ph-warning'>
            {scanError}
          </StatusSlot>
        </Main>
        <Footer>
          <Button variant='secondary' onClick={deny} className='w-[110px]'>
            don&apos;t sign
          </Button>
          <Button onClick={() => setScanError(null)} className='grow'>
            scan again
          </Button>
        </Footer>
      </div>
    ) : (
      <QrScanner onScan={handleAirgapScan} onClose={deny} title="zigner's answer" />
    );
  }

  const warnings = [
    hasTransparentAddress(selectedTransactionView) &&
      'this uses a transparent address, so the withdrawal is public',
    !hasAltGasFee(selectedTransactionView) &&
      'the fee is paid in another token than um, which can mark you · keeping some um for fees helps',
  ].filter(Boolean);

  return (
    <div className='flex h-full min-h-0 flex-col bg-canvas'>
      <ScreenHeader title='review transaction' backPath={false} meta='penumbra' />
      <Main className='gap-4 pt-5'>
        {invalidPlan && (
          <StatusSlot tone='danger' icon='i-ph-warning'>
            this transaction can&apos;t be signed ·{' '}
            {invalidPlan instanceof ConnectError ? invalidPlan.rawMessage : String(invalidPlan)}
          </StatusSlot>
        )}
        {selectedTransactionViewName === TransactionViewTab.SENDER &&
          warnings.map(w => (
            <StatusSlot key={String(w)} tone='warn' icon='i-ph-eye'>
              {w}
            </StatusSlot>
          ))}

        <ViewTabs
          defaultValue={selectedTransactionViewName}
          onValueChange={setSelectedTransactionViewName}
        />

        <Sensitive className='w-full'>
          <TransactionViewComponent txv={selectedTransactionView} metadataFetcher={getMetadata} />
        </Sensitive>

        {selectedTransactionViewName === TransactionViewTab.SENDER && (
          <Button
            variant='quiet'
            size='sm'
            onClick={() => setShowJson(true)}
            className='self-start px-0'
          >
            view the raw request
          </Button>
        )}
        <Sheet open={showJson} onOpenChange={setShowJson} title='raw request'>
          <div className='min-h-0 overflow-y-auto'>
            <JsonViewer
              jsonObj={
                new AuthorizeRequest(authorizeRequest).toJson() as Jsonified<AuthorizeRequest>
              }
            />
          </div>
        </Sheet>
      </Main>
      {isAirgap ? (
        <Footer>
          <Button variant='secondary' onClick={deny} className='w-[110px]'>
            don&apos;t sign
          </Button>
          <Button
            onClick={invalidPlan ? undefined : startAirgapSigning}
            disabled={!!invalidPlan}
            className='grow'
          >
            sign on zigner
          </Button>
        </Footer>
      ) : (
        <>
          <PasswordGateModal
            open={showPasswordGate}
            onConfirm={onGateConfirmed}
            onCancel={() => setShowPasswordGate(false)}
          />
          <ApproveDeny
            approve={invalidPlan ? undefined : () => void requestApproval()}
            deny={deny}
            approveLabel='sign & send'
            denyLabel="don't sign"
            wait={approvalWaitSeconds(txSigningSecurity)}
          />
        </>
      )}
    </div>
  );
};
