/**
 * animated QR display — cycles through multipart QR frames
 *
 * for payloads > ~2KB that don't fit in a single QR code.
 * splits the payload into numbered frames and cycles through them.
 * format: "P<frameIndex>/<totalFrames>/<base64chunk>"
 *
 * no external dependencies (avoids @ngraveio/bc-ur Node.js polyfill issues).
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode');

/** max bytes of base64 data per QR frame (keep QR scannable) */
const DEFAULT_CHUNK_SIZE = 400;

interface AnimatedQrDisplayProps {
  /** raw bytes to encode */
  data: Uint8Array;
  /** UR type string (e.g. 'zcash-notes') — included in frame prefix */
  urType: string;
  /** size of QR code in pixels */
  size?: number;
  /** max base64 chars per frame */
  chunkSize?: number;
  /** ms between frames */
  frameInterval?: number;
  /** title above QR */
  title?: string;
  /** description below QR */
  description?: string;
}

/** split payload into numbered frames: P<idx>/<total>/<type>/<base64> */
function buildFrames(data: Uint8Array, urType: string, chunkSize: number): string[] {
  const b64 = btoa(String.fromCharCode(...data));
  const totalChunks = Math.ceil(b64.length / chunkSize) || 1;
  const frames: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = b64.slice(i * chunkSize, (i + 1) * chunkSize);
    frames.push(`P${i + 1}/${totalChunks}/${urType}/${chunk}`);
  }
  return frames;
}

export function AnimatedQrDisplay({
  data,
  urType,
  size = 256,
  chunkSize = DEFAULT_CHUNK_SIZE,
  frameInterval = 300,
  title,
  description,
}: AnimatedQrDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameIndexRef = useRef(0);
  const [currentFrame, setCurrentFrame] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const frames = useMemo(() => {
    try {
      return buildFrames(data, urType, chunkSize);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to encode payload');
      return [];
    }
  }, [data, urType, chunkSize]);

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;

    const idx = frameIndexRef.current % frames.length;
    frameIndexRef.current = idx + 1;
    setCurrentFrame(idx + 1);

    QRCode.toCanvas(
      canvas,
      frames[idx],
      {
        width: size,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'L',
      },
      (err: Error | null) => {
        if (err) console.error('[animated-qr] frame error:', err);
      },
    );
  }, [frames, size]);

  useEffect(() => {
    if (frames.length === 0) return;

    renderFrame();

    if (frames.length > 1) {
      timerRef.current = setInterval(renderFrame, frameInterval);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [renderFrame, frameInterval, frames.length]);

  if (error) {
    return (
      <div className='flex flex-col items-center gap-2 p-4'>
        <p className='text-xs text-red-400'>{error}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col items-center gap-3'>
      {title && <h3 className='text-sm font-medium text-foreground'>{title}</h3>}

      <div className='relative rounded-lg bg-white p-3'>
        <canvas ref={canvasRef} />
        {frames.length > 1 && (
          <div className='absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white font-mono'>
            {currentFrame}/{frames.length}
          </div>
        )}
      </div>

      {frames.length > 1 && (
        <div className='flex items-center gap-2 text-[10px] text-muted-foreground'>
          <span className='i-lucide-loader-2 size-3 animate-spin' />
          scanning — hold camera steady
        </div>
      )}

      {description && (
        <p className='text-xs text-muted-foreground text-center max-w-xs'>{description}</p>
      )}

      <p className='text-[10px] text-muted-foreground'>
        {data.length.toLocaleString()} bytes · {frames.length} frame{frames.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
