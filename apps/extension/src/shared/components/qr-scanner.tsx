import { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';
import { Button } from '@repo/ui/components/ui/button';

interface QrScannerProps {
  onScan: (data: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
  /** render inline (card) instead of fullscreen overlay */
  inline?: boolean;
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
  title = 'scan QR code',
  description,
  inline = false,
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
      // TRY_HARDER improves detection of damaged/blurry QR codes at the cost of CPU
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.TRY_HARDER, true);

      const reader = new BrowserQRCodeReader(hints, {
        delayBetweenScanAttempts: 100, // scan ~10x/sec instead of default ~2x/sec
      });

      // request camera permission FIRST — Chrome MV3 extension pages may
      // auto-dismiss the permission prompt if enumerateDevices() runs before
      // getUserMedia(). Getting a stream first ensures the prompt is shown.
      const initialStream = await navigator.mediaDevices.getUserMedia({ video: true });
      initialStream.getTracks().forEach(t => t.stop()); // release, we just needed the permission

      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      const camera = devices.find((d: MediaDeviceInfo) =>
        /back|rear|environment/i.test(d.label),
      ) || devices[0];

      if (!camera) throw new Error('No camera found');

      // request higher resolution + continuous autofocus for sharper QR capture
      const videoConstraints: MediaTrackConstraints = {
        deviceId: camera.deviceId,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
      // focusMode is supported on mobile Chrome but not in the TS type defs
      Object.assign(videoConstraints, { focusMode: { ideal: 'continuous' } });

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const controls = await reader.decodeFromVideoDevice(
        undefined, // use the stream already attached to the video element
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
        // side panels and popups can't show permission prompts.
        // open a dedicated window to request camera access, then retry.
        try {
          const grantUrl = chrome.runtime.getURL('page.html#/grant-camera');
          const tab = await chrome.tabs.create({ url: grantUrl, active: true });
          // wait for the tab to close (user granted or denied)
          await new Promise<void>(resolve => {
            const listener = (tabId: number) => {
              if (tabId === tab.id) {
                chrome.tabs.onRemoved.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onRemoved.addListener(listener);
          });
          // retry - if permission was granted this will work
          startingRef.current = false;
          void startScanning();
          return;
        } catch {
          // fallback if tabs API not available
        }
        setError('permission');
      } else if (/NotReadable|AbortError|Could not start/i.test(msg)) {
        setError('Camera is in use by another app. Close it and retry.');
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

  // corner bracket color
  const cornerColor = inline ? 'border-yellow-500' : 'border-green-500';
  const scanLineColor = inline ? 'bg-yellow-500' : 'bg-green-500';

  // shared camera viewport
  const cameraView = (
    <>
      <video
        ref={videoRef}
        className='absolute inset-0 w-full h-full object-cover'
        playsInline
        muted
      />

      {isScanning && (
        <div className='absolute inset-0 pointer-events-none flex items-center justify-center'>
          <div className={`relative ${inline ? 'w-44 h-44' : 'w-64 h-64'}`}>
            <div className={`absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] ${cornerColor} rounded-tl-lg`} />
            <div className={`absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] ${cornerColor} rounded-tr-lg`} />
            <div className={`absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] ${cornerColor} rounded-bl-lg`} />
            <div className={`absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] ${cornerColor} rounded-br-lg`} />
            <div className={`absolute inset-x-0 top-0 h-0.5 ${scanLineColor} animate-scan`} />
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
            <div className='p-3 rounded-full bg-red-500/20'>
              <span className='i-lucide-camera size-6 text-red-400' />
            </div>
            {error === 'permission' ? (
              <>
                <p className='text-xs text-red-400'>camera access is required to scan QR codes</p>
                <div className='flex gap-2'>
                  <Button variant='secondary' size='sm' onClick={handleClose}>cancel</Button>
                  <Button size='sm' onClick={() => { setError(null); void startScanning(); }}>grant access</Button>
                </div>
              </>
            ) : (
              <>
                <p className='text-xs text-red-400'>{error}</p>
                <div className='flex gap-2'>
                  <Button variant='secondary' size='sm' onClick={handleClose}>cancel</Button>
                  <Button size='sm' onClick={() => { setError(null); void startScanning(); }}>retry</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );

  // inline mode: compact card with rounded camera
  if (inline) {
    return (
      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between'>
          <span className='text-xs text-fg-muted'>{title}</span>
          <button
            onClick={handleClose}
            className='p-0.5 text-fg-muted hover:text-fg-high transition-colors'
          >
            <span className='i-lucide-x h-3.5 w-3.5' />
          </button>
        </div>
        <div className='relative aspect-square w-full overflow-hidden rounded-lg border border-yellow-500/40 bg-black'>
          {cameraView}
        </div>
        {description && (
          <p className='text-[10px] text-fg-muted text-center'>{description}</p>
        )}
        <style>{`
          @keyframes scan {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(170px); }
          }
          .animate-scan { animation: scan 2s ease-in-out infinite; }
        `}</style>
      </div>
    );
  }

  // fullscreen overlay mode (used by zcash-send etc.)
  return (
    <div className='fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex flex-col overflow-hidden'>
      <div className='flex-none flex items-center justify-between p-4 bg-black'>
        <div>
          <h2 className='text-lg font-medium text-white'>{title}</h2>
          {description && <p className='text-sm text-white/60'>{description}</p>}
        </div>
        <button
          onClick={handleClose}
          className='p-2 rounded-full hover:bg-white/10 transition-colors'
        >
          <span className='i-lucide-x size-6 text-white' />
        </button>
      </div>

      <div className='flex-1 relative min-h-0 overflow-hidden'>
        {cameraView}
      </div>

      {isScanning && (
        <div className='flex-none p-4 bg-black text-center'>
          <p className='text-sm text-white/60'>position the QR code within the frame</p>
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
