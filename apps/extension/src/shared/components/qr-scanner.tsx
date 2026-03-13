import { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { CameraIcon, Cross1Icon } from '@radix-ui/react-icons';
import { Button } from '@repo/ui/components/ui/button';

interface QrScannerProps {
  onScan: (data: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}

/** Convert ZXing result text to hex — handles binary QR (Latin-1) and plain hex */
function resultToHex(text: string): string {
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return text;

  const hasBinary = Array.from(text).some(c => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code > 0x7E;
  });

  if (hasBinary) {
    return Array.from(text).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }
  return text;
}

export const QrScanner = ({
  onScan,
  onError,
  onClose,
  title = 'Scan QR Code',
  description = 'Point your camera at the QR code',
}: QrScannerProps) => {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const scannedRef = useRef(false);

  // Stable refs for callbacks — avoids re-creating startScanning on every render
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  onScanRef.current = onScan;
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
    if (!videoRef.current || startingRef.current) return;
    startingRef.current = true;

    try {
      setError(null);
      const reader = new BrowserQRCodeReader();
      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      const camera = devices.find((d: MediaDeviceInfo) =>
        /back|rear|environment/i.test(d.label),
      ) || devices[0];

      if (!camera) throw new Error('No camera found');

      const controls = await reader.decodeFromVideoDevice(
        camera.deviceId,
        videoRef.current,
        (result) => {
          if (result && !scannedRef.current) {
            scannedRef.current = true;
            stopScanning();
            onScanRef.current(resultToHex(result.getText()));
          }
        },
      );

      controlsRef.current = controls;
      startingRef.current = false;
      if (mountedRef.current) setIsScanning(true);
    } catch (err) {
      startingRef.current = false;
      const msg = err instanceof Error ? err.message : 'Failed to start camera';

      if (/Permission|NotAllowed/.test(msg)) {
        setError('Camera permission denied. Enable camera access in browser settings.');
      } else if (/NotFound|no camera/i.test(msg)) {
        setError('No camera found on this device.');
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
    <div className='fixed inset-0 z-50 bg-black flex flex-col overflow-hidden'>
      <div className='flex-none flex items-center justify-between p-4 bg-black/80'>
        <div>
          <h2 className='text-lg font-bold text-white'>{title}</h2>
          <p className='text-sm text-gray-400'>{description}</p>
        </div>
        <button
          onClick={handleClose}
          className='p-2 rounded-full hover:bg-white/10 transition-colors'
        >
          <Cross1Icon className='size-6 text-white' />
        </button>
      </div>

      <div className='flex-1 relative min-h-0 overflow-hidden'>
        <video
          ref={videoRef}
          className='absolute inset-0 w-full h-full object-cover'
          playsInline
          muted
        />

        {isScanning && (
          <div className='absolute inset-0 pointer-events-none'>
            <div className='absolute inset-0 flex items-center justify-center'>
              <div className='relative w-64 h-64'>
                <div className='absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-green-500 rounded-tl' />
                <div className='absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-green-500 rounded-tr' />
                <div className='absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-green-500 rounded-bl' />
                <div className='absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-green-500 rounded-br' />
                <div className='absolute inset-x-0 top-0 h-0.5 bg-green-500 animate-scan' />
              </div>
            </div>
          </div>
        )}

        {!isScanning && !error && (
          <div className='absolute inset-0 flex items-center justify-center bg-black'>
            <div className='flex flex-col items-center gap-3 text-white'>
              <CameraIcon className='size-12 animate-pulse' />
              <span className='text-base'>Starting camera...</span>
            </div>
          </div>
        )}

        {error && (
          <div className='absolute inset-0 flex items-center justify-center bg-black p-6'>
            <div className='flex flex-col items-center gap-4 text-center max-w-sm'>
              <div className='p-4 rounded-full bg-red-500/20'>
                <CameraIcon className='size-8 text-red-400' />
              </div>
              <p className='text-red-400'>{error}</p>
              <div className='flex gap-3'>
                <Button variant='secondary' onClick={handleClose}>
                  Cancel
                </Button>
                <Button variant='gradient' onClick={startScanning}>
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {isScanning && (
        <div className='flex-none p-4 bg-black/80 text-center'>
          <p className='text-sm text-gray-400'>Position the QR code within the frame</p>
        </div>
      )}

      <style>{`
        @keyframes scan {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(250px); }
        }
        .animate-scan { animation: scan 2s ease-in-out infinite; }
      `}</style>
    </div>
  );
};
