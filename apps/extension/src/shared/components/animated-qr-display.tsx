/**
 * animated QR display — cycles through BC-UR fountain-coded parts
 *
 * for payloads > ~2KB that don't fit in a single QR code.
 * uses @ngraveio/bc-ur UREncoder to split into fountain-coded parts
 * and cycles through them so the scanning device can reassemble.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import URlib from '@ngraveio/bc-ur';

const { UR, UREncoder } = URlib;

// dynamic import for qrcode
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode');

interface AnimatedQrDisplayProps {
  /** raw bytes to encode */
  data: Uint8Array;
  /** UR type string (e.g. 'zcash-notes') */
  urType: string;
  /** size of QR code in pixels */
  size?: number;
  /** max bytes per fragment (smaller = more frames but scannable on worse cameras) */
  maxFragmentLength?: number;
  /** ms between frames */
  frameInterval?: number;
  /** title above QR */
  title?: string;
  /** description below QR */
  description?: string;
}

export function AnimatedQrDisplay({
  data,
  urType,
  size = 256,
  maxFragmentLength = 200,
  frameInterval = 250,
  title,
  description,
}: AnimatedQrDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const encoderRef = useRef<InstanceType<typeof UREncoder> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFragments, setTotalFragments] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // create encoder once
  useEffect(() => {
    try {
      const ur = new UR(Buffer.from(data), urType);
      const encoder = new UREncoder(ur, maxFragmentLength);
      encoderRef.current = encoder;
      setTotalFragments(encoder.fragmentsLength);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to create UR encoder');
    }
  }, [data, urType, maxFragmentLength]);

  const renderFrame = useCallback(() => {
    const encoder = encoderRef.current;
    const canvas = canvasRef.current;
    if (!encoder || !canvas) return;

    const part = encoder.nextPart();
    setCurrentFrame(prev => prev + 1);

    QRCode.toCanvas(
      canvas,
      part.toUpperCase(), // UR parts are case-insensitive, uppercase = alphanumeric QR mode = smaller
      {
        width: size,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'L',
      },
      (err: Error | null) => {
        if (err) {
          console.error('[animated-qr] frame error:', err);
        }
      },
    );
  }, [size]);

  // start animation loop
  useEffect(() => {
    if (!encoderRef.current) return;

    // render first frame immediately
    renderFrame();

    timerRef.current = setInterval(renderFrame, frameInterval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [renderFrame, frameInterval, totalFragments]);

  if (error) {
    return (
      <div className='flex flex-col items-center gap-2 p-4'>
        <p className='text-xs text-red-400'>{error}</p>
      </div>
    );
  }

  const displayFrame = totalFragments > 0 ? ((currentFrame - 1) % totalFragments) + 1 : 0;

  return (
    <div className='flex flex-col items-center gap-3'>
      {title && <h3 className='text-sm font-medium text-foreground'>{title}</h3>}

      <div className='relative rounded-lg bg-white p-3'>
        <canvas ref={canvasRef} />
        {totalFragments > 1 && (
          <div className='absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white font-mono'>
            {displayFrame}/{totalFragments}
          </div>
        )}
      </div>

      {totalFragments > 1 && (
        <div className='flex items-center gap-2 text-[10px] text-muted-foreground'>
          <span className='i-lucide-loader-2 size-3 animate-spin' />
          scanning — hold camera steady
        </div>
      )}

      {description && (
        <p className='text-xs text-muted-foreground text-center max-w-xs'>{description}</p>
      )}

      <p className='text-[10px] text-muted-foreground'>
        {data.length.toLocaleString()} bytes · {totalFragments} fragment{totalFragments !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
