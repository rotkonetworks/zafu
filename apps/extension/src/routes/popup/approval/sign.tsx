import { useState, useEffect, useCallback } from 'react';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { signApprovalSelector } from '../../../state/sign-approval';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { UserChoice } from '@repo/storage-chrome/records';
import { signZid, signP256, resolveZid, type ZidSitePreference } from '../../../state/identity';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { hexToBytes } from '@noble/hashes/utils';
import { localExtStorage } from '@repo/storage-chrome/local';
import { QrScanner } from '../../../shared/components/qr-scanner';

type SignStep = 'review' | 'password' | 'show-qr' | 'scan-qr' | 'signing';

export const SignApproval = () => {
  const { origin, challengeHex, statement, algorithm, isAirgap, zidPubkey, setChoice, sendResponse } =
    useStore(signApprovalSelector);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);
  const checkPassword = useStore(s => s.keyRing.checkPassword);

  const [step, setStep] = useState<SignStep>('review');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [previewAddress, setPreviewAddress] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState<string>('site #0');
  const [pref, setPref] = useState<ZidSitePreference | undefined>();

  // resolve preview address and signing preference
  useEffect(() => {
    if (!origin) return;
    void (async () => {
      const prefs = await localExtStorage.get('zidPreferences');
      const raw = prefs?.[origin] as Partial<ZidSitePreference> | undefined;
      const resolved: ZidSitePreference | undefined = raw ? {
        mode: raw.mode === 'cross-site' ? 'cross-site' : 'site',
        rotation: raw.rotation ?? 0,
        identity: raw.identity ?? 'default',
      } : undefined;
      setPref(resolved);
      const isSite = !resolved || resolved.mode === 'site';
      setSigningMode(isSite ? `site #${resolved?.rotation ?? 0}` : 'cross-site');

      // zigner wallet: use stored pubkey for preview
      if (isAirgap) {
        if (zidPubkey) setPreviewAddress('zid' + zidPubkey.slice(0, 16));
        else setPreviewAddress(null);
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

      if (!keyInfo) return;
      try {
        const mnemonic = await getMnemonic(keyInfo.id);
        const zid = resolveZid(mnemonic, origin, resolved);
        setPreviewAddress(zid.address);
      } catch {
        // mnemonic not available yet — will derive after password
      }
    })();
  }, [keyInfo, origin, isAirgap, zidPubkey]);

  // mnemonic: sign after password verification
  const signWithMnemonic = useCallback(async () => {
    if (!keyInfo || !challengeHex || !origin) return;
    setStep('signing');

    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const challenge = hexToBytes(challengeHex);
      const result = algorithm === 'es256'
        ? signP256(mnemonic, origin, challenge, pref)
        : signZid(mnemonic, origin, challenge, pref);

      // log the shared zid
      const log = (await localExtStorage.get('zidShareLog')) ?? [];
      const alreadyLogged = log.some(r => r.publicKey === result.publicKey && r.sharedWith === origin);
      if (!alreadyLogged) {
        log.push({
          publicKey: result.publicKey,
          sharedWith: origin,
          sharedAt: Date.now(),
          identity: pref?.identity ?? 'default',
        });
        void localExtStorage.set('zidShareLog', log);
      }

      setChoice(UserChoice.Approved);
      sendResponse(result);
    } catch (e) {
      console.error('identity signing failed:', e);
      setChoice(UserChoice.Denied);
      sendResponse();
    }
    window.close();
  }, [keyInfo, challengeHex, origin, algorithm, pref, getMnemonic, setChoice, sendResponse]);

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
  const handleZidResponse = useCallback((raw: string) => {
    try {
      const resp = JSON.parse(raw);
      if (resp.type !== 'zid-resp' || !resp.signature || !resp.publicKey) {
        throw new Error('invalid response format');
      }

      // log the shared zid
      void (async () => {
        const log = (await localExtStorage.get('zidShareLog')) ?? [];
        const alreadyLogged = log.some(r => r.publicKey === resp.publicKey && r.sharedWith === origin);
        if (!alreadyLogged) {
          log.push({
            publicKey: resp.publicKey,
            sharedWith: origin!,
            sharedAt: Date.now(),
            identity: pref?.identity ?? 'default',
          });
          void localExtStorage.set('zidShareLog', log);
        }
      })();

      setChoice(UserChoice.Approved);
      sendResponse({ signature: resp.signature, publicKey: resp.publicKey });
      window.close();
    } catch {
      // invalid QR, keep scanning
    }
  }, [origin, pref, setChoice, sendResponse]);

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
    window.close();
  };

  if (!origin) return null;

  // build challenge QR data for zigner
  const challengeQr = isAirgap ? JSON.stringify({
    type: 'zid-sign',
    v: 1,
    challenge: challengeHex,
    identity: pref?.identity ?? 'default',
    mode: pref?.mode ?? 'site',
    origin,
    rotation: pref?.rotation ?? 0,
    algorithm: algorithm ?? 'ed25519',
    statement: statement ?? '',
  }) : '';

  return (
    <FadeTransition>
      <div className='flex min-h-screen w-screen flex-col gap-6'>
        <h1 className='flex h-[70px] items-center justify-center border-b border-border/40 font-headline text-xl font-medium leading-[30px]'>
          {step === 'show-qr' ? 'Sign with Zigner' : step === 'scan-qr' ? 'Scan Response' : 'Sign Message'}
        </h1>

        {/* ── review step ── */}
        {step === 'review' && (
          <>
            <div className='mx-auto flex size-20 items-center justify-center rounded-full bg-muted'>
              <span className='i-lucide-fingerprint h-10 w-10 text-muted-foreground' />
            </div>
            <div className='w-full px-[30px]'>
              <div className='flex flex-col gap-3'>
                <div className='flex min-h-11 w-full items-center overflow-x-auto rounded-lg bg-muted p-3 text-muted-foreground'>
                  <div className='mx-auto items-center text-center leading-[0.8em]'>
                    {origin && <DisplayOriginURL url={new URL(origin)} />}
                  </div>
                </div>
                {statement && (
                  <div className='rounded-lg border border-border/40 p-3 text-sm text-muted-foreground'>
                    {statement}
                  </div>
                )}
                <div className='rounded-lg bg-muted p-3'>
                  <p className='text-xs text-muted-foreground'>challenge</p>
                  <p className='mt-1 break-all font-mono text-xs'>
                    {challengeHex && challengeHex.length > 64
                      ? challengeHex.slice(0, 64) + '...'
                      : challengeHex}
                  </p>
                </div>
                {previewAddress && (
                  <div className='rounded-lg border border-border/40 p-3'>
                    <p className='text-[10px] text-muted-foreground/60 mb-1'>
                      signing as ({signingMode}){isAirgap ? ' — zigner' : ''}
                    </p>
                    <p className='font-mono text-xs break-all'>{previewAddress}</p>
                  </div>
                )}
                <p className='text-sm text-muted-foreground'>
                  this site is requesting a signature from your identity key.
                  this will not authorize any transactions.
                </p>
              </div>
            </div>
            <div className='flex grow flex-col justify-end'>
              <ApproveDeny approve={approve} deny={deny} />
            </div>
          </>
        )}

        {/* ── password step (mnemonic only) ── */}
        {step === 'password' && (
          <div className='w-full px-[30px] flex flex-col gap-4'>
            <div className='mx-auto flex size-16 items-center justify-center rounded-full bg-muted'>
              <span className='i-lucide-lock h-8 w-8 text-muted-foreground' />
            </div>
            <p className='text-sm text-muted-foreground text-center'>enter password to sign</p>
            <input
              type='password'
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handlePasswordSubmit(); }}
              className='w-full rounded-lg border border-border/40 bg-muted p-3 text-sm outline-none focus:border-foreground/40'
              placeholder='password'
            />
            {passwordError && (
              <p className='text-xs text-red-400 text-center'>{passwordError}</p>
            )}
            <div className='flex gap-3 mt-2'>
              <button
                onClick={() => { setStep('review'); setPassword(''); setPasswordError(''); }}
                className='flex-1 rounded-lg border border-border/40 p-3 text-sm text-muted-foreground hover:bg-muted'
              >
                back
              </button>
              <button
                onClick={() => void handlePasswordSubmit()}
                className='flex-1 rounded-lg bg-foreground p-3 text-sm text-background font-medium hover:bg-foreground/90'
              >
                sign
              </button>
            </div>
          </div>
        )}

        {/* ── signing spinner ── */}
        {step === 'signing' && (
          <div className='flex flex-col items-center justify-center gap-3 py-12'>
            <span className='i-lucide-loader-2 h-8 w-8 text-muted-foreground animate-spin' />
            <p className='text-sm text-muted-foreground'>signing...</p>
          </div>
        )}

        {/* ── show QR step (zigner only) ── */}
        {step === 'show-qr' && (
          <div className='w-full px-[30px] flex flex-col gap-4 items-center'>
            <p className='text-sm text-muted-foreground text-center'>
              scan this QR with your zigner device
            </p>
            <div className='bg-white p-3 rounded-lg'>
              <QrCanvas data={challengeQr} size={240} />
            </div>
            <div className='rounded-lg bg-muted p-3 w-full'>
              <p className='text-[10px] text-muted-foreground/60'>origin</p>
              <p className='font-mono text-xs'>{origin}</p>
            </div>
            <button
              onClick={() => setStep('scan-qr')}
              className='w-full rounded-lg bg-foreground p-3 text-sm text-background font-medium hover:bg-foreground/90'
            >
              scan signed response
            </button>
            <button
              onClick={() => setStep('review')}
              className='text-xs text-muted-foreground hover:text-foreground'
            >
              back
            </button>
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
      </div>
    </FadeTransition>
  );
};

/* ── QR canvas for challenge display ── */
const QrCanvas = ({ data, size }: { data: string; size: number }) => {
  const ref = (canvas: HTMLCanvasElement | null) => {
    if (!canvas || !data) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode');
      QRCode.toCanvas(canvas, data, { width: size, margin: 1, color: { dark: '#000', light: '#fff' }, errorCorrectionLevel: 'L' });
    } catch { /* */ }
  };
  return <canvas ref={ref} />;
};
