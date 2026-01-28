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

/**
 * Full-screen QR Code scanner using ZXing (fast, reliable)
 */
export const QrScanner = ({
  onScan,
  onError,
  onClose,
  title = 'Scan QR Code',
  description = 'Point your camera at the QR code'
}: QrScannerProps) => {
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const mountedRef = useRef(true);

  const stopScanning = useCallback(() => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    if (mountedRef.current) {
      setIsScanning(false);
    }
  }, []);

  const startScanning = useCallback(async () => {
    if (!videoRef.current) return;

    try {
      setError(null);

      const reader = new BrowserQRCodeReader();
      readerRef.current = reader;

      // Get back camera
      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      const backCamera = devices.find((d: MediaDeviceInfo) =>
        d.label.toLowerCase().includes('back') ||
        d.label.toLowerCase().includes('rear') ||
        d.label.toLowerCase().includes('environment')
      ) || devices[0];

      if (!backCamera) {
        throw new Error('No camera found');
      }

      const controls = await reader.decodeFromVideoDevice(
        backCamera.deviceId,
        videoRef.current,
        (result) => {
          if (result) {
            stopScanning();
            const text = result.getText();

            // Check if this is binary data (Zigner format starts with 'S' = 0x53)
            // ZXing decodes BYTE mode QR codes as Latin-1, so 'S' indicates our binary format
            if (text.length > 0 && text.charCodeAt(0) === 0x53) {
              // Convert Latin-1 text back to hex bytes
              const hex = Array.from(text)
                .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
                .join('');
              onScan(hex);
            } else if (/^[0-9a-fA-F]+$/.test(text)) {
              // Already hex-encoded
              onScan(text);
            } else {
              // Text/URL QR code - pass as-is
              onScan(text);
            }
          }
          // Ignore decode errors (no QR in frame)
        }
      );

      controlsRef.current = controls;

      if (mountedRef.current) {
        setIsScanning(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start camera';

      if (message.includes('Permission') || message.includes('NotAllowed')) {
        setError('Camera permission denied. Enable camera access in browser settings.');
      } else if (message.includes('NotFound') || message.includes('no camera')) {
        setError('No camera found on this device.');
      } else {
        setError(message);
      }

      onError?.(message);
    }
  }, [onScan, onError, stopScanning]);

  // Start on mount, cleanup on unmount
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
      {/* Header */}
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

      {/* Scanner viewport */}
      <div className='flex-1 relative min-h-0 overflow-hidden'>
        <video
          ref={videoRef}
          className='absolute inset-0 w-full h-full object-cover'
          playsInline
          muted
        />

        {/* Scanning overlay with frame */}
        {isScanning && (
          <div className='absolute inset-0 pointer-events-none'>
            <div className='absolute inset-0 flex items-center justify-center'>
              <div className='relative w-64 h-64'>
                {/* Corner markers */}
                <div className='absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-green-500 rounded-tl' />
                <div className='absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-green-500 rounded-tr' />
                <div className='absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-green-500 rounded-bl' />
                <div className='absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-green-500 rounded-br' />

                {/* Scanning line animation */}
                <div className='absolute inset-x-0 top-0 h-0.5 bg-green-500 animate-scan' />
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {!isScanning && !error && (
          <div className='absolute inset-0 flex items-center justify-center bg-black'>
            <div className='flex flex-col items-center gap-3 text-white'>
              <CameraIcon className='size-12 animate-pulse' />
              <span className='text-base'>Starting camera...</span>
            </div>
          </div>
        )}

        {/* Error state */}
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

      {/* Bottom hint */}
      {isScanning && (
        <div className='flex-none p-4 bg-black/80 text-center'>
          <p className='text-sm text-gray-400'>
            Position the QR code within the frame
          </p>
        </div>
      )}

      {/* CSS for scan animation */}
      <style>{`
        @keyframes scan {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(250px); }
        }
        .animate-scan {
          animation: scan 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
};
