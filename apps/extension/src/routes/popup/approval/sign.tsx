import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { signApprovalSelector } from '../../../state/sign-approval';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { UserChoice } from '@repo/storage-chrome/records';
import { signZid } from '../../../state/identity';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { hexToBytes } from '@noble/hashes/utils';

export const SignApproval = () => {
  const { origin, challengeHex, statement, setChoice, sendResponse } =
    useStore(signApprovalSelector);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);

  const approve = async () => {
    if (!keyInfo || !challengeHex) return;

    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const challenge = hexToBytes(challengeHex);
      // TODO: load per-site preference from storage and pass to signZid
      const result = signZid(mnemonic, origin!, challenge);
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
