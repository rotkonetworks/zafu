import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../../state';
import { signApprovalSelector } from '../../../state/sign-approval';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon } from '../../../shared/components/origin-icon';
import { QrCode } from '../../../components/qr-code';
import { Mark } from '@repo/ui/components/ui/mark';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { UserChoice } from '@repo/storage-chrome/records';
import {
  signZid,
  signP256,
  resolveZid,
  getZidIndex,
  type ZidSitePreference,
} from '../../../state/identity';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { hexToBytes } from '@noble/hashes/utils';
import { localExtStorage } from '@repo/storage-chrome/local';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { exitApprovalSurface, usePopupNav } from '../../../utils/navigate';
import { useApprovalFixture } from './use-approval-fixture';
import { hostnameOf } from '../../../shared/components/origin-icon';

type SignStep = 'review' | 'password' | 'show-qr' | 'scan-qr' | 'signing';

export const SignApproval = () => {
  const navigate = usePopupNav();
  const {
    origin,
    title,
    challengeHex,
    statement,
    algorithm,
    isAirgap,
    zidPubkey,
    setChoice,
    sendResponse,
  } = useStore(signApprovalSelector);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);
  const checkPassword = useStore(s => s.keyRing.checkPassword);
  const acceptRequest = useStore(s => s.signApproval.acceptRequest);

  useApprovalFixture(!!origin, () => {
    void acceptRequest({
      origin: 'https://zk.poker',
      title: 'zk.poker',
      challengeHex: 'deadbeef'.repeat(4),
      algorithm: 'ed25519',
    });
  });

  const [step, setStep] = useState<SignStep>('review');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [previewAddress, setPreviewAddress] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState('site #0');
  const [pref, setPref] = useState<ZidSitePreference | undefined>();

  // resolve preview address and signing preference
  useEffect(() => {
    if (!origin) {
      return;
    }
    void (async () => {
      const prefs = await localExtStorage.get('zidPreferences');
      const raw = prefs?.[origin] as Partial<ZidSitePreference> | undefined;
      const resolved: ZidSitePreference | undefined = raw
        ? {
            mode: raw.mode === 'cross-site' ? 'cross-site' : 'site',
            rotation: raw.rotation ?? 0,
            identity: raw.identity ?? 'default',
          }
        : undefined;
      setPref(resolved);
      const isSite = !resolved || resolved.mode === 'site';
      setSigningMode(isSite ? `site #${resolved?.rotation ?? 0}` : 'cross-site');

      // zigner wallet: use stored pubkey for preview
      if (isAirgap) {
        if (zidPubkey) {
          setPreviewAddress('zid' + zidPubkey.slice(0, 16));
        } else {
          setPreviewAddress(null);
        }
        return;
      }

      // mnemonic wallet: check share log first, then derive
      const log = await localExtStorage.get('zidShareLog');
      const entries = (log ?? []).filter(r => r.sharedWith === origin);
      const latest = entries[entries.length - 1];
      if (latest) {
        setPreviewAddress('zid' + latest.publicKey.slice(0, 16));
        return;
      }

      if (!keyInfo) {
        return;
      }
      try {
        const mnemonic = await getMnemonic(keyInfo.id);
        const zidIndex = await getZidIndex();
        const zid = resolveZid(mnemonic, origin, resolved, zidIndex);
        setPreviewAddress(zid.address);
      } catch {
        // mnemonic not available yet - will derive after password
      }
    })();
  }, [keyInfo, origin, isAirgap, zidPubkey]);

  // mnemonic: sign after password verification
  const signWithMnemonic = useCallback(async () => {
    if (!keyInfo || !challengeHex || !origin) {
      return;
    }
    setStep('signing');

    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const challenge = hexToBytes(challengeHex);
      const zidIndex = await getZidIndex();
      const result =
        algorithm === 'es256'
          ? signP256(mnemonic, origin, challenge, pref)
          : signZid(mnemonic, origin, challenge, pref, zidIndex);

      // share log is written by the service worker (sign-request.ts) after popup closes
      setChoice(UserChoice.Approved);
      sendResponse(result);
    } catch (e) {
      console.error('identity signing failed:', e);
      setChoice(UserChoice.Denied);
      sendResponse();
    }
    exitApprovalSurface(navigate);
  }, [
    keyInfo,
    challengeHex,
    origin,
    algorithm,
    pref,
    getMnemonic,
    setChoice,
    sendResponse,
    navigate,
  ]);

  const handlePasswordSubmit = useCallback(async () => {
    setPasswordError('');
    const valid = await checkPassword(password);
    if (!valid) {
      setPasswordError('incorrect password');
      return;
    }
    await signWithMnemonic();
  }, [password, checkPassword, signWithMnemonic]);

  // zigner: handle scanned QR response
  const handleZidResponse = useCallback(
    (raw: string) => {
      try {
        const resp = JSON.parse(raw);
        if (resp.type !== 'zid-resp' || !resp.signature || !resp.publicKey) {
          throw new Error('invalid response format');
        }

        // share log is written by the service worker (sign-request.ts) after popup closes
        setChoice(UserChoice.Approved);
        sendResponse({ signature: resp.signature, publicKey: resp.publicKey });
        exitApprovalSurface(navigate);
      } catch {
        // invalid QR, keep scanning
      }
    },
    [setChoice, sendResponse, navigate],
  );

  const approve = () => {
    if (isAirgap) {
      setStep('show-qr');
    } else {
      setStep('password');
    }
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    exitApprovalSurface(navigate);
  };

  if (!origin) {
    return null;
  }

  // build challenge QR data for zigner
  const challengeQr = isAirgap
    ? JSON.stringify({
        type: 'zid-sign',
        v: 1,
        challenge: challengeHex,
        identity: pref?.identity ?? 'default',
        mode: pref?.mode ?? 'site',
        origin,
        rotation: pref?.rotation ?? 0,
        algorithm: algorithm ?? 'ed25519',
        statement: statement ?? '',
      })
    : '';

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          {origin && (
            <div className='flex w-full items-center gap-2'>
              <OriginIcon origin={origin} size={32} />
              <div className='flex min-w-0 flex-col'>
                {title && <span className='truncate text-sm text-fg-high'>{title}</span>}
                <span className='truncate text-xs text-fg-muted'>
                  <DisplayOriginURL url={new URL(origin)} />
                </span>
              </div>
            </div>
          )}
          {step === 'review' && <Mark variant='seal' size={40} />}
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            {step === 'show-qr'
              ? 'sign with zigner'
              : step === 'scan-qr'
                ? 'scan response'
                : step === 'password'
                  ? 'enter password'
                  : `sign in to ${origin ? hostnameOf(origin) : 'this site'}`}
          </h1>
        </header>
      }
      footer={
        step === 'review' ? (
          <ApproveDeny approve={approve} deny={deny} approveLabel='sign in' denyLabel='not now' />
        ) : undefined
      }
    >
      {/* ── review step ── */}
      {step === 'review' && (
        <div className='w-full px-[30px]'>
          <div className='flex flex-col gap-3'>
            {statement && (
              <div className='border border-border-soft p-3 text-xs text-fg'>{statement}</div>
            )}
            {previewAddress && (
              <div className='border border-border-soft p-3'>
                <p className='kicker mb-1'>
                  as ({signingMode}){isAirgap ? ' - zigner' : ''}
                </p>
                <p className='tabular text-xs text-fg-high break-all'>{previewAddress}</p>
              </div>
            )}
            <p className='text-xs text-fg-muted'>
              {origin ? hostnameOf(origin) : 'this site'} learns nothing about your wallet or other
              sites.
            </p>
          </div>
        </div>
      )}

      {/* ── password step (mnemonic only) ── */}
      {step === 'password' && (
        <div className='w-full px-[30px] flex flex-col gap-4'>
          <Input
            type='password'
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                void handlePasswordSubmit();
              }
            }}
            placeholder='password'
            variant={passwordError ? 'error' : 'default'}
          />
          {passwordError && <p className='text-xs text-red-400'>{passwordError}</p>}
          <div className='flex gap-3'>
            <Button
              variant='secondary'
              className='flex-1'
              onClick={() => {
                setStep('review');
                setPassword('');
                setPasswordError('');
              }}
            >
              back
            </Button>
            <Button
              variant='primary'
              className='flex-1'
              onClick={() => void handlePasswordSubmit()}
            >
              sign
            </Button>
          </div>
        </div>
      )}

      {/* ── signing spinner ── */}
      {step === 'signing' && (
        <div className='flex flex-col items-center justify-center gap-3 py-12'>
          <span className='i-ph-circle-notch h-8 w-8 text-fg-muted animate-spin' />
          <p className='text-sm text-fg-muted'>signing...</p>
        </div>
      )}

      {/* ── show QR step (zigner only) ── */}
      {step === 'show-qr' && (
        <div className='w-full px-[30px] flex flex-col gap-4 items-center'>
          <QrCode value={challengeQr} size={240} label='zigner sign-challenge QR' />
          <Button variant='primary' className='w-full' onClick={() => setStep('scan-qr')}>
            scan signed response
          </Button>
          <Button variant='quiet' size='sm' onClick={() => setStep('review')}>
            back
          </Button>
        </div>
      )}

      {/* ── scan QR step (zigner only) ── */}
      {step === 'scan-qr' && (
        <div className='w-full px-[30px]'>
          <QrScanner
            inline
            title='scan zigner response'
            description='point at the signed response QR on your zigner device'
            onScan={handleZidResponse}
            onClose={() => setStep('show-qr')}
          />
        </div>
      )}
    </ApprovalScreen>
  );
};
