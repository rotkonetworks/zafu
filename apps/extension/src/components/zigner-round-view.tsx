/**
 * The two steps of one zigner round, as the send screen shows them: the
 * request as an animated qr, then the camera for the device's signed answer.
 * The caller frames it (a popup screen, or lp.html's sheet).
 */

import { useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@repo/ui/components/ui/button';
import { AnimatedQrDisplay } from '../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../shared/components/animated-qr-scanner';
import type { ZignerRound } from '../signing/zigner-round';

/** "ur:zigner-module/1-3/..." -> "zigner-module": the answer comes back under the same type */
const urTypeOf = (frames: string[]) =>
  frames[0]?.split('/')[0]?.replace(/^ur:/i, '') || 'zigner-module';

/** the round's one action: read zigner's answer, or back to the qr */
export const ZignerRoundAction = ({ round }: { round: ZignerRound }) =>
  useStore(round.store, s => s.scanning) ? (
    <Button variant='secondary' onClick={() => round.scan(false)} className='w-full'>
      show the qr again
    </Button>
  ) : (
    <Button onClick={() => round.scan(true)} className='w-full'>
      scan zigner's answer
    </Button>
  );

/**
 * The request, or the camera. `pinned` leaves the action out for the caller's
 * footer; the qr takes the room left (never under 240 px), so the screen
 * never scrolls.
 */
export const ZignerRoundView = ({ round, pinned }: { round: ZignerRound; pinned?: boolean }) => {
  const { shown, scanning } = useStore(round.store);
  // a camera that would not start, said under the qr it goes back to
  const [cameraError, setCameraError] = useState<string>();
  if (!shown) {
    return null;
  }
  const urType = urTypeOf(shown.urFrames);
  return (
    <div className='flex min-h-0 w-full grow flex-col items-center gap-4'>
      {scanning ? (
        <>
          <AnimatedQrScanner
            inline
            onComplete={bytes => void round.answer(bytes)}
            onError={err => {
              setCameraError(err);
              round.scan(false);
            }}
            onClose={() => round.scan(false)}
            title="zigner's answer"
            urTypeFilter={urType}
          />
          <span className='text-[13px] text-fg-high'>hold zigner's signed qr up to the camera</span>
        </>
      ) : (
        <>
          <AnimatedQrDisplay
            bare
            urFrames={shown.urFrames}
            urSource={shown.cborData ? { bytes: shown.cborData, urType } : undefined}
            totalBytes={shown.cborBytes}
            size={300}
            frameInterval={200}
          />
          <span className='text-[13px] text-fg-high'>scan this with zigner, approve there</span>
          {cameraError && <span className='text-xs text-warn'>{cameraError}</span>}
        </>
      )}
      {!pinned && <ZignerRoundAction round={round} />}
    </div>
  );
};
