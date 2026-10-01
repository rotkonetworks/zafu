import type { ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { ScreenHeader } from '../../../components/screen-header';
import type { LedgerSigningPhase } from '../../../ledger/zcash-app/contract';
import { Footer, Main, Mark, Strip } from './send-ui';

/** the eye line: what the person can rely on while this state lasts */
const Assure = ({ warn, children }: { warn?: boolean; children: ReactNode }) => (
  <div
    className={
      warn
        ? 'flex min-h-[54px] w-full items-center gap-2.5 border border-warn/40 bg-warn/10 px-3.5 py-2.5'
        : 'flex min-h-[52px] w-full items-center gap-2.5 border border-border-soft px-3.5 py-2.5'
    }
  >
    <span className={`i-lucide-eye size-4 shrink-0 ${warn ? 'text-warn' : 'text-fg-muted'}`} />
    <span className='text-xs leading-normal text-fg'>{children}</span>
  </div>
);

/** board StWitness: the note tree is rebuilt before this send can prove */
export const WitnessRebuild = ({
  step,
  left,
  onBackground,
}: {
  /** the worker's latest rebuild sub-step, if any */
  step?: string;
  left?: string;
  onBackground: () => void;
}) => (
  <>
    <ScreenHeader title='preparing to send' onBack={onBackground} />
    <Main className='gap-[18px] pt-7'>
      <p className='text-[13px] leading-relaxed text-fg'>
        witness corrupt - rebuilding. this takes about 3 min.
      </p>
      <div className='flex h-[58px] shrink-0 items-center gap-3 border border-border-soft bg-elev-1 px-3.5'>
        <span className='size-2 shrink-0 animate-pulse bg-zigner-gold' />
        <span className='flex grow flex-col gap-[3px]'>
          <span className='text-sm text-fg-high'>witness corrupt - rebuilding</span>
          <span className='text-[11px] text-fg-muted'>{step ?? 'reading the note tree'}</span>
        </span>
      </div>
      <Assure>your zec stays exactly where it is while this runs</Assure>
    </Main>
    <Footer>
      <Button variant='secondary' onClick={onBackground} className='w-[110px] text-[13px]'>
        wait in background
      </Button>
      <Button disabled className='grow'>
        {left ?? 'rebuilding'}
      </Button>
    </Footer>
  </>
);

const LEDGER_STEPS = [
  'ledger connected',
  'zcash app open',
  'check the address on the device, then approve',
] as const;
const LEDGER_AT: Record<LedgerSigningPhase['phase'], number> = {
  connecting: 0,
  open_app: 1,
  sending: 2,
  review: 2,
  done: 2,
};

/** board SignLedger's steps: the zcash app reports each one; without a
 *  phase (the bitcoin app) only the step the device is truly on is shown */
export const LedgerSteps = ({ phase }: { phase?: LedgerSigningPhase['phase'] }) => {
  const at = phase ? LEDGER_AT[phase] : LEDGER_STEPS.length - 1;
  return (
    <ol className='flex w-full flex-col divide-y divide-border-soft border border-border-soft bg-elev-1 text-[13px] text-fg-high'>
      {LEDGER_STEPS.map((label, i) =>
        phase || i === at ? (
          <li key={label} className='flex min-h-12 items-center gap-3 px-3.5 py-2'>
            <Mark state={i < at ? 'done' : i === at ? 'now' : 'wait'} />
            {label}
          </li>
        ) : null,
      )}
    </ol>
  );
};

/** board StLedgerGone: the device went away mid-sign; the build is kept */
export const LedgerGone = ({
  sending,
  pool,
  onCancel,
  onReconnect,
}: {
  sending: ReactNode;
  pool: string;
  onCancel: () => void;
  onReconnect: () => void;
}) => (
  <>
    <ScreenHeader title='confirm on ledger' backPath={false} />
    <Strip right={pool}>{sending}</Strip>
    <Main className='items-center gap-[26px] px-6 pt-[34px]'>
      <div className='flex h-[76px] w-[250px] shrink-0 items-center gap-3.5 border border-warn/40 bg-elev-2 px-4 opacity-60'>
        <span className='flex h-[42px] w-[150px] flex-col justify-center border border-border-soft bg-canvas px-2.5'>
          <span className='text-[10px] text-fg-muted'>no device</span>
        </span>
        <span className='i-lucide-x size-[22px] text-warn' />
      </div>
      <ol className='flex w-full flex-col divide-y divide-border-soft border border-border-soft bg-elev-1 text-[13px]'>
        <li className='flex h-12 items-center gap-3 px-3.5 text-fg-muted'>
          <span className='size-3.5 shrink-0 border border-border-hard' />
          ledger connected
        </li>
        <li className='flex h-12 items-center gap-3 px-3.5 text-warn'>
          <span className='size-3.5 shrink-0 bg-warn' />
          lost the connection
        </li>
      </ol>
      <Assure warn>
        nothing was signed. reconnect the ledger and open the zcash app to try again.
      </Assure>
    </Main>
    <Footer>
      <Button variant='secondary' onClick={onCancel} className='w-[110px]'>
        cancel
      </Button>
      <Button onClick={onReconnect} className='grow'>
        reconnect ledger
      </Button>
    </Footer>
  </>
);

/** board StZignerWrongNet: the code shown belongs to the other chain */
export const ZignerWrongCode = ({
  device,
  shown,
  wanted,
  sending,
  onBack,
  onScanAgain,
}: {
  device: string;
  shown: string;
  wanted: string;
  sending: ReactNode;
  onBack: () => void;
  onScanAgain: () => void;
}) => (
  <>
    <ScreenHeader title={`sign on ${device}`} onBack={onBack} />
    <Strip icon='i-lucide-asterisk'>{sending}</Strip>
    <Main className='items-center gap-4 px-5 pt-6'>
      <div className='relative size-[180px] shrink-0 border border-warn/40 bg-elev-1 opacity-50'>
        <span className='absolute left-3 top-3 size-[26px] border-l-2 border-t-2 border-warn' />
        <span className='absolute right-3 top-3 size-[26px] border-r-2 border-t-2 border-warn' />
        <span className='absolute bottom-3 left-3 size-[26px] border-b-2 border-l-2 border-warn' />
        <span className='absolute bottom-3 right-3 size-[26px] border-b-2 border-r-2 border-warn' />
      </div>
      <div className='flex min-h-[66px] w-full items-center gap-2.5 border border-warn/40 bg-warn/10 px-3.5 py-2.5'>
        <span className='i-lucide-eye size-4 shrink-0 text-warn' />
        <span className='text-xs leading-normal text-fg'>
          this code is {device}&apos;s <span className='text-fg-high'>{shown}</span> code. this
          payment needs its <span className='text-fg-high'>{wanted}</span> code.
        </span>
      </div>
      <span className='text-xs text-fg-muted'>
        on {device}, switch to {wanted} and show its code again
      </span>
    </Main>
    <Footer>
      <Button onClick={onScanAgain} className='w-full'>
        scan again
      </Button>
    </Footer>
  </>
);
