import { useState, useEffect } from 'react';
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

export const SignApproval = () => {
  const { origin, challengeHex, statement, algorithm, setChoice, sendResponse } =
    useStore(signApprovalSelector);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);

  // preview: try share log first (no mnemonic), fall back to derivation
  const [previewAddress, setPreviewAddress] = useState<string | null>(null);
  const [signingMode, setSigningMode] = useState<string>('site #0');

  useEffect(() => {
    if (!origin) return;
    void (async () => {
      const prefs = await localExtStorage.get('zidPreferences');
      const raw = prefs?.[origin] as Partial<ZidSitePreference> | undefined;
      const pref: ZidSitePreference | undefined = raw ? {
        mode: raw.mode === 'cross-site' ? 'cross-site' : 'site',
        rotation: raw.rotation ?? 0,
        identity: raw.identity ?? 'default',
      } : undefined;
      const isSite = !pref || pref.mode === 'site';
      setSigningMode(isSite ? `site #${pref?.rotation ?? 0}` : 'cross-site');

      // check share log first - avoids touching mnemonic
      const log = await localExtStorage.get('zidShareLog');
      const entries = (log ?? []).filter(r => r.sharedWith === origin);
      const latest = entries[entries.length - 1];
      if (latest) {
        setPreviewAddress('zid' + latest.publicKey.slice(0, 16));
        return;
      }

      // first time with this site - derive to show preview
      if (!keyInfo) return;
      const mnemonic = await getMnemonic(keyInfo.id);
      const zid = resolveZid(mnemonic, origin, pref);
      setPreviewAddress(zid.address);
    })();
  }, [keyInfo, origin]);

  const approve = async () => {
    if (!keyInfo || !challengeHex) return;

    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const challenge = hexToBytes(challengeHex);
      const prefs = await localExtStorage.get('zidPreferences');
      const raw2 = prefs?.[origin!] as Partial<ZidSitePreference> | undefined;
      const pref: ZidSitePreference | undefined = raw2 ? {
        mode: raw2.mode === 'cross-site' ? 'cross-site' : 'site',
        rotation: raw2.rotation ?? 0,
        identity: raw2.identity ?? 'default',
      } : undefined;
      const result = algorithm === 'es256'
        ? signP256(mnemonic, origin!, challenge, pref)
        : signZid(mnemonic, origin!, challenge, pref);

      // log the zid we signed with so the connections page can display it
      const log = (await localExtStorage.get('zidShareLog')) ?? [];
      const alreadyLogged = log.some(r => r.publicKey === result.publicKey && r.sharedWith === origin);
      if (!alreadyLogged) {
        log.push({
          publicKey: result.publicKey,
          sharedWith: origin!,
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
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    window.close();
  };

  if (!origin) {
    return null;
  }

  return (
    <FadeTransition>
      <div className='flex min-h-screen w-screen flex-col gap-6'>
        <h1 className='flex h-[70px] items-center justify-center border-b border-border/40 font-headline text-xl font-medium leading-[30px]'>
          Sign Message
        </h1>
        <div className='mx-auto flex size-20 items-center justify-center rounded-full bg-muted'>
          <span className='i-lucide-pen-tool h-10 w-10 text-muted-foreground' />
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
              <p className='text-xs text-muted-foreground'>Challenge</p>
              <p className='mt-1 break-all font-mono text-xs'>
                {challengeHex && challengeHex.length > 64
                  ? challengeHex.slice(0, 64) + '...'
                  : challengeHex}
              </p>
            </div>
            {previewAddress && (
              <div className='rounded-lg border border-border/40 p-3'>
                <p className='text-[10px] text-muted-foreground/60 mb-1'>signing as ({signingMode})</p>
                <p className='font-mono text-xs break-all'>{previewAddress}</p>
              </div>
            )}
            <p className='text-sm text-muted-foreground'>
              This site is requesting a signature from your wallet identity.
              This will not authorize any transactions.
            </p>
          </div>
        </div>
        <div className='flex grow flex-col justify-end'>
          <ApproveDeny approve={approve} deny={deny} />
        </div>
      </div>
    </FadeTransition>
  );
};
