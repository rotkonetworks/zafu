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

export const ZignerRoundView = ({ round, size = 300 }: { round: ZignerRound; size?: number }) => {
  const { shown, scanning } = useStore(round.store);
  // a camera that would not start, said under the qr it goes back to
  const [cameraError, setCameraError] = useState<string>();
  if (!shown) {
    return null;
  }
  const urType = urTypeOf(shown.urFrames);
  return (
    <div className='flex flex-col items-center gap-4'>
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
            size={size}
            frameInterval={200}
          />
          <span className='text-[13px] text-fg-high'>scan this with zigner, approve there</span>
          {cameraError && <span className='text-xs text-warn'>{cameraError}</span>}
        </>
      )}
      {scanning ? (
        <Button variant='secondary' onClick={() => round.scan(false)} className='w-full'>
          show the qr again
        </Button>
      ) : (
        <Button
          onClick={() => {
            setCameraError(undefined);
            round.scan(true);
          }}
          className='w-full'
        >
          scan zigner's answer
        </Button>
      )}
    </div>
  );
};
