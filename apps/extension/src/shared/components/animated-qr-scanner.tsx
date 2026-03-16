/**
 * animated QR scanner — reassembles multipart QR frames from camera
 *
 * scans multiple QR frames continuously, collecting numbered parts
 * until the full payload is reconstructed. shows progress %.
 *
 * frame format: "P<frameIndex>/<totalFrames>/<urType>/<base64chunk>"
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { Button } from '@repo/ui/components/ui/button';

interface AnimatedQrScannerProps {
  /** called when all parts have been received and reassembled */
  onComplete: (data: Uint8Array, urType: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}

export const AnimatedQrScanner = ({
  onComplete,
  onError,
  onClose,
  title = 'scan animated QR',
  description,
}: AnimatedQrScannerProps) => {
  const [progress, setProgress] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partsReceived, setPartsReceived] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);

  // collected frames: index -> base64 chunk
  const framesRef = useRef<Map<number, string>>(new Map());
  const totalRef = useRef(0);
  const urTypeRef = useRef('');

  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  const stopScanning = useCallback(() => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    if (mountedRef.current) setIsScanning(false);
  }, []);

  const startScanning = useCallback(async () => {
    if (!videoRef.current) return;

    try {
      setError(null);
      const reader = new BrowserQRCodeReader();
      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      const camera = devices.find((d: MediaDeviceInfo) =>
        /back|rear|environment/i.test(d.label),
      ) || devices[0];

      if (!camera) throw new Error('no camera found');

      const controls = await reader.decodeFromVideoDevice(
        camera.deviceId,
        videoRef.current,
        (result) => {
          if (!result || completedRef.current) return;

          const text = result.getText();
          // parse frame: P<idx>/<total>/<type>/<data>
          const match = text.match(/^P(\d+)\/(\d+)\/([^/]+)\/(.+)$/);
          if (!match) return;

          const idx = Number(match[1]);
          const total = Number(match[2]);
          const type = match[3]!;
          const chunk = match[4]!;

          if (totalRef.current === 0) {
            totalRef.current = total;
            urTypeRef.current = type;
          }

          if (!framesRef.current.has(idx)) {
            framesRef.current.set(idx, chunk);
            setPartsReceived(framesRef.current.size);
            setProgress(Math.round((framesRef.current.size / total) * 100));
          }

          // check if complete
          if (framesRef.current.size >= total) {
            completedRef.current = true;
            stopScanning();

            try {
              // reassemble in order
              let b64 = '';
              for (let i = 1; i <= total; i++) {
                b64 += framesRef.current.get(i) || '';
              }
              const binary = atob(b64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              onCompleteRef.current(bytes, urTypeRef.current);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'failed to decode';
              setError(msg);
              onErrorRef.current?.(msg);
            }
          }
        },
      );

      controlsRef.current = controls;
      if (mountedRef.current) setIsScanning(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to start camera';
      if (/Permission|NotAllowed/.test(msg)) {
        setError('camera permission denied');
      } else if (/NotFound|no camera/i.test(msg)) {
        setError('no camera found');
      } else {
        setError(msg);
      }
      onErrorRef.current?.(msg);
    }
  }, [stopScanning]);

  useEffect(() => {
    mountedRef.current = true;
    void startScanning();
    return () => {
      mountedRef.current = false;
      stopScanning();
    };
  }, [startScanning, stopScanning]);

  const handleClose = () => {
    stopScanning();
    onClose();
  };

  return (
    <div className='fixed inset-0 z-50 flex flex-col overflow-hidden bg-black'>
      <div className='flex-none flex items-center justify-between p-4 bg-black/80'>
        <div>
          <h2 className='text-lg font-medium text-white'>{title}</h2>
          {description && <p className='text-sm text-white/60'>{description}</p>}
        </div>
        <button
          onClick={handleClose}
          className='rounded-full p-2 hover:bg-white/10 transition-colors'
        >
          <span className='i-lucide-x size-6 text-white' />
        </button>
      </div>

      <div className='flex-1 relative min-h-0 overflow-hidden'>
        <video
          ref={videoRef}
          className='absolute inset-0 h-full w-full object-cover'
          playsInline
          muted
        />

        {isScanning && (
          <div className='absolute inset-0 pointer-events-none flex items-center justify-center'>
            <div className='relative w-64 h-64'>
              <div className='absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-green-500 rounded-tl-lg' />
              <div className='absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-green-500 rounded-tr-lg' />
              <div className='absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-green-500 rounded-bl-lg' />
              <div className='absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-green-500 rounded-br-lg' />
            </div>
          </div>
        )}

        {!isScanning && !error && (
          <div className='absolute inset-0 flex items-center justify-center bg-black'>
            <div className='flex flex-col items-center gap-2 text-white'>
              <span className='i-lucide-camera size-8 animate-pulse' />
              <span className='text-sm'>starting camera...</span>
            </div>
          </div>
        )}

        {error && (
          <div className='absolute inset-0 flex items-center justify-center bg-black p-4'>
            <div className='flex flex-col items-center gap-3 text-center'>
              <div className='rounded-full bg-red-500/20 p-3'>
                <span className='i-lucide-camera size-6 text-red-400' />
              </div>
              <p className='text-xs text-red-400'>{error}</p>
              <div className='flex gap-2'>
                <Button variant='secondary' size='sm' onClick={handleClose}>cancel</Button>
                <Button size='sm' onClick={startScanning}>retry</Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* progress bar */}
      <div className='flex-none bg-black/80 p-4'>
        <div className='flex items-center gap-3'>
          <div className='flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden'>
            <div
              className='h-full rounded-full bg-green-500 transition-all duration-300'
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className='text-xs font-mono text-white/80 w-12 text-right'>
            {progress}%
          </span>
        </div>
        <p className='mt-1.5 text-[10px] text-white/40 text-center'>
          {partsReceived} part{partsReceived !== 1 ? 's' : ''} received — hold camera steady over animated QR
        </p>
      </div>
    </div>
  );
};
