import { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
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
 * Full-screen QR Code scanner overlay using device camera
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
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const mountedRef = useRef(true);

  const stopScanning = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        // Ignore stop errors
      }
      scannerRef.current = null;
    }
    if (mountedRef.current) {
      setIsScanning(false);
    }
  }, []);

  const startScanning = useCallback(async () => {
    try {
      setError(null);

      const scanner = new Html5Qrcode('qr-scanner-viewport');
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
        },
        (decodedText) => {
          // Success - stop scanning and return result
          void stopScanning();
          onScan(decodedText);
        },
        () => {
          // QR code not found in frame - ignore
        }
      );

      if (mountedRef.current) {
        setIsScanning(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start camera';

      if (message.includes('Permission') || message.includes('NotAllowed')) {
        setError('Camera permission denied. Enable camera access in browser settings and try again.');
      } else if (message.includes('NotFound') || message.includes('no camera')) {
        setError('No camera found on this device.');
      } else {
        setError(message);
      }

      onError?.(message);
    }
  }, [onScan, onError, stopScanning]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    void startScanning();

    return () => {
      mountedRef.current = false;
      void stopScanning();
    };
  }, [startScanning, stopScanning]);

  const handleClose = () => {
    void stopScanning();
    onClose();
  };

  return (
    <div className='fixed inset-0 z-50 bg-black flex flex-col'>
      {/* Header */}
      <div className='flex items-center justify-between p-4 bg-black/80'>
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
      <div className='flex-1 relative'>
        <div
          id='qr-scanner-viewport'
          className='absolute inset-0'
        />

        {/* Scanning overlay with frame */}
        {isScanning && (
          <div className='absolute inset-0 pointer-events-none'>
            {/* Dark overlay with transparent center */}
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
        <div className='p-4 bg-black/80 text-center'>
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
