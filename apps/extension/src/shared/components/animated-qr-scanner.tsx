/**
 * animated QR scanner — reassembles multipart QR frames from camera
 *
 * Supports two modes:
 * 1. legacy "P<frameIndex>/<totalFrames>/<urType>/<base64chunk>" — fixed parts
 * 2. BC-UR fountain-coded `ur:<type>/...` — variable parts, decode via WASM
 *
 * Auto-detects mode from the first scanned frame's prefix.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Button } from '@repo/ui/components/ui/button';

interface AnimatedQrScannerProps {
  /** called when all parts have been received and reassembled */
  onComplete: (data: Uint8Array, urType: string) => void;
  onError?: (error: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
  /** render inline (card) instead of fullscreen overlay — popup contexts trap `fixed` */
  inline?: boolean;
  /**
   * Optional: restrict to a specific UR type. If set and the first scanned
   * frame is a UR frame, only `ur:<urTypeFilter>/...` frames are accepted.
   * Useful when scanning a known-format response (e.g. zcash-pczt sign).
   */
  urTypeFilter?: string;
}

export const AnimatedQrScanner = ({
  onComplete,
  onError,
  onClose,
  title = 'scan animated QR',
  description,
  inline = false,
  urTypeFilter,
}: AnimatedQrScannerProps) => {
  const [progress, setProgress] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partsReceived, setPartsReceived] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);

  // collected frames: index -> base64 chunk (legacy P-format)
  const framesRef = useRef<Map<number, string>>(new Map());
  const totalRef = useRef(0);
  const urTypeRef = useRef('');

  // BC-UR fountain mode state. Distinct set from legacy P-frames because
  // UR fountain parts don't have a fixed total — we keep accumulating until
  // ur_decode_frames returns a complete payload.
  const urPartsRef = useRef<Set<string>>(new Set());
  // 'p' = legacy P-format, 'ur' = BC-UR fountain, '' = undecided
  const modeRef = useRef<'' | 'p' | 'ur'>('');
  // wasm module loaded lazily on first UR frame
  const wasmRef = useRef<{ ur_decode_frames: (parts: string, type: string) => string } | null>(null);
  const wasmInitInFlightRef = useRef(false);
  // seqLen from UR header — drives honest progress vs the emitter's cycle
  const urSeqLenRef = useRef(0);
  // Stall watchdog. A healthy fountain stream always yields *new* unique
  // parts; "need more frames" and "this will never complete" are otherwise
  // indistinguishable, so without this a corrupt/dead signer produces an
  // unbounded "scanning..." with no failure. If no new unique part arrives
  // for STALL_MS we surface a hard error. 12s is ~3x the slowest realistic
  // animated-QR cycle — long enough not to false-positive on a slow camera,
  // short enough to not be "infinite".
  const lastNewPartAtRef = useRef(0);
  const STALL_MS = 12_000;

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
      // TRY_HARDER + QR_CODE-only + tight cadence — animated UR cycles at
      // 4 fps; ZXing default delay (500ms) misses ~half the frames. 30ms
      // is the worker thread's natural budget on a typical webcam.
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);

      const reader = new BrowserQRCodeReader(hints, {
        delayBetweenScanAttempts: 30,
      });

      // prime camera permission before enumerateDevices (Chrome MV3 quirk)
      const initialStream = await navigator.mediaDevices.getUserMedia({ video: true });
      initialStream.getTracks().forEach(t => t.stop());

      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      const camera = devices.find((d: MediaDeviceInfo) =>
        /back|rear|environment/i.test(d.label),
      ) || devices[0];

      if (!camera) throw new Error('no camera found');

      const videoConstraints: MediaTrackConstraints = {
        deviceId: camera.deviceId,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
      Object.assign(videoConstraints, { focusMode: { ideal: 'continuous' } });

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          if (!result || completedRef.current) return;

          const text = result.getText();

          // ── BC-UR fountain mode ──
          // ur:<type>/<seqNum>-<seqLen>/<bytewords> for multipart, or
          // ur:<type>/<bytewords> for single-part. Either way, accumulate the
          // raw frame string and let `ur_decode_frames` (wasm) handle dedup +
          // fountain reconstruction.
          const lower = text.toLowerCase();
          if (lower.startsWith('ur:')) {
            if (modeRef.current === '') modeRef.current = 'ur';
            if (modeRef.current !== 'ur') return;

            // type filter — defends against unrelated QR contaminating the stream
            const slashIdx = text.indexOf('/');
            const urType = slashIdx > 3 ? text.slice(3, slashIdx) : '';
            if (urTypeFilter && urType.toLowerCase() !== urTypeFilter.toLowerCase()) return;
            if (urTypeRef.current === '') urTypeRef.current = urType;
            else if (urTypeRef.current !== urType) return; // type drift, reject

            const before = urPartsRef.current.size;
            urPartsRef.current.add(text);
            if (urPartsRef.current.size === before) return; // duplicate

            // a genuinely new unique part — reset the stall clock
            lastNewPartAtRef.current = Date.now();
            setPartsReceived(urPartsRef.current.size);

            // seqLen drives honest progress; without it we'd pin at 99%.
            if (urSeqLenRef.current === 0) {
              const seqMatch = lower.match(/^ur:[^/]+\/(\d+)-(\d+)\//);
              if (seqMatch) urSeqLenRef.current = Number(seqMatch[2]);
            }

            // `default()` must be awaited — without it the bindgen glue's
            // `wasm` is undefined and exported calls die on `__wbindgen_*`.
            if (!wasmRef.current && !wasmInitInFlightRef.current) {
              wasmInitInFlightRef.current = true;
              import(/* webpackMode: "eager" */ '@repo/zcash-wasm')
                .then(async (mod: unknown) => {
                  // bindgen's default export fetches+instantiates the .wasm
                  const m = mod as {
                    default: (opts?: { module_or_path?: string }) => Promise<unknown>;
                    ur_decode_frames: (parts: string, type: string) => string;
                  };
                  await m.default();
                  wasmRef.current = m;
                })
                .catch(err => {
                  console.warn('[ur-scanner] wasm init failed:', err);
                  wasmInitInFlightRef.current = false; // allow retry on next frame
                });
            }
            const wasm = wasmRef.current;
            if (!wasm) return; // not loaded yet; keep accumulating

            try {
              const partsJson = JSON.stringify([...urPartsRef.current]);
              const hex = wasm.ur_decode_frames(partsJson, urType);
              // success → reconstructed
              completedRef.current = true;
              stopScanning();
              const bytes = new Uint8Array(hex.length >> 1);
              for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
              }
              setProgress(100);
              onCompleteRef.current(bytes, urType);
            } catch (e) {
              // sample errors so a real decode bug surfaces without spam
              if (urPartsRef.current.size % 8 === 0) {
                console.warn(
                  `[ur-scanner] decode failed at ${urPartsRef.current.size} parts (${urType}): ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              const seqLen = urSeqLenRef.current;
              const pct = seqLen > 0
                ? Math.min(99, Math.round((urPartsRef.current.size / seqLen) * 100))
                : Math.min(99, urPartsRef.current.size * 10);
              setProgress(pct);
            }
            return;
          }

          // ── legacy P-format mode ──
          if (modeRef.current === '') modeRef.current = 'p';
          if (modeRef.current !== 'p') return;

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
    // Pre-load wasm in parallel with camera startup. Without this, the first
    // ~1-2s of scanning is wasted while the user points the camera and the
    // wasm module is still fetching/instantiating.
    if (!wasmRef.current && !wasmInitInFlightRef.current) {
      wasmInitInFlightRef.current = true;
      import(/* webpackMode: "eager" */ '@repo/zcash-wasm')
        .then(async (mod: unknown) => {
          const m = mod as {
            default: (opts?: { module_or_path?: string }) => Promise<unknown>;
            ur_decode_frames: (parts: string, type: string) => string;
          };
          await m.default();
          if (mountedRef.current) wasmRef.current = m;
        })
        .catch(err => {
          console.warn('[ur-scanner] wasm preload failed:', err);
          wasmInitInFlightRef.current = false;
        });
    }
    void startScanning();

    // Stall watchdog: fires only once UR accumulation has actually started
    // (>=1 part) and only if no new unique part has arrived for STALL_MS.
    // Legacy P-format has a known total so it doesn't need this; the guard
    // on urPartsRef.size keeps it inert for that path.
    const stallTimer = setInterval(() => {
      if (completedRef.current) return;
      if (urPartsRef.current.size === 0) return; // not accumulating yet
      if (Date.now() - lastNewPartAtRef.current < STALL_MS) return;
      completedRef.current = true; // latch so we report once
      stopScanning();
      const msg =
        `scan stalled — no new QR frames for ${Math.round(STALL_MS / 1000)}s ` +
        `(${urPartsRef.current.size} parts received). The signer may have ` +
        `closed, or the stream is corrupt. Restart the signing flow.`;
      if (mountedRef.current) setError(msg);
      onErrorRef.current?.(msg);
    }, 2_000);

    return () => {
      mountedRef.current = false;
      clearInterval(stallTimer);
      stopScanning();
    };
  }, [startScanning, stopScanning]);

  const handleClose = () => {
    stopScanning();
    onClose();
  };

  const cornerColor = inline ? 'border-yellow-500' : 'border-green-500';
  const progressColor = inline ? 'bg-yellow-500' : 'bg-green-500';

  const cameraView = (
    <>
      <video
        ref={videoRef}
        className='absolute inset-0 h-full w-full object-cover'
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
    </>
  );

  const progressBar = (
    <>
      <div className='flex items-center gap-3'>
        <div className={`flex-1 ${inline ? 'h-1' : 'h-1.5'} rounded-full bg-white/10 overflow-hidden`}>
          <div
            className={`h-full rounded-full ${progressColor} transition-all duration-300`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className={`${inline ? 'text-[10px]' : 'text-xs'} font-mono text-white/80 w-12 text-right`}>
          {progress}%
        </span>
      </div>
      <p className={`mt-1.5 ${inline ? 'text-[9px]' : 'text-[10px]'} text-white/40 text-center`}>
        {partsReceived} part{partsReceived !== 1 ? 's' : ''} received — hold camera steady over animated QR
      </p>
    </>
  );

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
        <div className='rounded-md bg-black/60 p-2'>{progressBar}</div>
      </div>
    );
  }

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

      <div className='flex-1 relative min-h-0 overflow-hidden'>{cameraView}</div>

      <div className='flex-none bg-black/80 p-4'>{progressBar}</div>
    </div>
  );
};
