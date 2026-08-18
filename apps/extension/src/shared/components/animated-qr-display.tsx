/**
 * animated QR display — cycles through multipart QR frames
 *
 * for payloads > ~2KB that don't fit in a single QR code.
 * splits the payload into numbered frames and cycles through them.
 * format: "P<frameIndex>/<totalFrames>/<base64chunk>" (legacy P-format)
 * or BC-UR fountain frames ("ur:<type>/...").
 *
 * no external dependencies (avoids @ngraveio/bc-ur Node.js polyfill issues;
 * BC-UR encoding for UR flows goes through the wasm ur_encode_frames).
 *
 * Two controls:
 *   QR speed   — ms per frame (how fast the animation cycles)
 *   QR density — payload bytes per frame (Safe 400B / Medium 800B / Aggressive
 *                1.2KB). Higher density = fewer frames but a higher QR version,
 *                which needs a sharper camera. Persistent per-install.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode');

/** max base64 chars per frame when building legacy P-frames */
const DEFAULT_CHUNK_SIZE = 400;

/** density presets: payload bytes per QR frame → QR version ≈ */
interface DensityPreset {
  key: 'fragile' | 'safe' | 'medium' | 'aggressive';
  label: string;
  bytes: number;
  detail: string;
}
export const QR_DENSITY_PRESETS: DensityPreset[] = [
  // 'fragile': lowest QR version, for bad laptop/webcam cameras that cannot lock
  // a denser code. More frames, but each is trivially scannable.
  { key: 'fragile', label: 'fragile', bytes: 100, detail: '~v6 · worst cameras' },
  { key: 'safe', label: 'safe', bytes: 400, detail: '~v16 · wide compat' },
  { key: 'medium', label: 'medium', bytes: 800, detail: '~v22 · phone+webcam' },
  { key: 'aggressive', label: 'aggressive', bytes: 1200, detail: '~v25 · close-up setup' },
];
const DENSITY_MIN = 100;
const DENSITY_MAX = 1600;

/** closest preset for a stored/custom value */
const clampPreset = (bytes: number): number => {
  const n = typeof bytes === 'number' && bytes >= DENSITY_MIN ? Math.round(bytes) : 400;
  return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, n));
};

interface AnimatedQrDisplayProps {
  /** raw bytes to encode (used with legacy P-frame format) */
  data?: Uint8Array;
  /** pre-built UR string frames (e.g. from WASM ur_encode_frames) */
  urFrames?: string[];
  /** UR type string (e.g. 'zcash-notes', 'zafu-stream') — used with data prop */
  urType?: string;
  /** size of QR code in pixels */
  size?: number;
  /** max base64 chars per frame (legacy mode; kept for back-compat) */
  chunkSize?: number;
  /** ms between frames (default 300 = ~3 fps; 200/120 used by some flows) */
  frameInterval?: number;
  /** show the live playback-speed slider under the QR (default true, multipart only) */
  showSpeedControl?: boolean;
  /** show the QR density slider (payload bytes/frame). Needs `data` or `urSource`. */
  showDensityControl?: boolean;
  /** initial payload-bytes-per-frame density (default 400 = safe) */
  densityBytes?: number;
  /**
   * raw fountain source for UR flows — lets the component re-fountain frames at
   * the chosen density via wasm ur_encode_frames. Without it, pre-built
   * urFrames can't be re-densified and the density slider is hidden.
   */
  urSource?: { bytes: Uint8Array; urType: string };
  /** title above QR */
  title?: string;
  /** description below QR */
  description?: string;
  /** total bytes for display (when using urFrames, data.length isn't available) */
  totalBytes?: number;
}

/** split payload into numbered frames: P<idx>/<total>/<type>/<base64> (legacy) */
function buildFrames(data: Uint8Array, urType: string, chunkChars: number): string[] {
  const b64 = btoa(String.fromCharCode(...data));
  const totalChunks = Math.ceil(b64.length / chunkChars) || 1;
  const frames: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = b64.slice(i * chunkChars, (i + 1) * chunkChars);
    frames.push(`P${i + 1}/${totalChunks}/${urType}/${chunk}`);
  }
  return frames;
}

/** payload bytes per frame → legacy P-frame base64 chars per frame (bytes * 4/3) */
const bytesToB64Chars = (bytes: number) => Math.ceil((bytes * 4) / 3);

/** estimate the QR version a frame of `payloadBytes` would use (QR spec, byte mode @ EC L) */
function estimateQrVersion(payloadBytes: number): number {
  try {
    // all-zero bytes at EC L → the smallest version that fits `payloadBytes`
    const qr = QRCode.create(Buffer.alloc(payloadBytes), { errorCorrectionLevel: 'L' });
    if (typeof qr?.version === 'number' && qr.version > 0) {
      return qr.version;
    }
  } catch {
    /* qrcode lib unavailable/sparse — fall through to the table */
  }
  // QR capacity table (bytes, EC L); first version whose capacity is >= payloadBytes
  const CAP: [number, number][] = [
    [16, 41],
    [20, 109],
    [24, 249],
    [28, 443],
    [32, 689],
    [36, 989],
    [40, 1307],
  ];
  for (const [v, cap] of CAP) {
    if (payloadBytes <= cap) {
      return v;
    }
  }
  return 40;
}

export function AnimatedQrDisplay({
  data,
  urFrames,
  urType,
  size = 256,
  chunkSize = DEFAULT_CHUNK_SIZE,
  frameInterval = 300,
  showSpeedControl = true,
  showDensityControl = true,
  densityBytes = 400,
  urSource,
  title,
  description,
  totalBytes,
}: AnimatedQrDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameIndexRef = useRef(0);
  const [currentFrame, setCurrentFrame] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // ── playback speed (ms/frame) with a persisted preference ──────────────
  const [intervalMs, setIntervalMs] = useState(frameInterval);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clampSpeed = (v: number) => Math.min(700, Math.max(60, Math.round(v)));

  useEffect(() => {
    let cancelled = false;
    const apply = (v: unknown) => {
      if (!cancelled) {
        setIntervalMs(clampSpeed(typeof v === 'number' ? v : frameInterval));
      }
    };
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local
          .get(['qrPlaybackIntervalMs'])
          .then(r => apply(r?.['qrPlaybackIntervalMs']));
      } else {
        apply(undefined);
      }
    } catch {
      apply(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [frameInterval]);

  const changeSpeed = useCallback((v: number) => {
    const n = clampSpeed(v);
    setIntervalMs(n);
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
    }
    persistTimer.current = setTimeout(() => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          void chrome.storage.local.set({ qrPlaybackIntervalMs: n });
        }
      } catch {
        /* non-extension environment */
      }
    }, 250);
  }, []);

  // ── density (payload bytes/frame) with a persisted preference ──────────
  // back-compat: a legacy caller's chunkSize seeds the density when no explicit
  // densityBytes is given (persisted pref still wins once loaded).
  const [density, setDensity] = useState<number>(() => clampPreset(densityBytes ?? chunkSize));
  // UR-source frames get re-fountained at the chosen density (async wasm)
  const [urDensityFrames, setUrDensityFrames] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (v: unknown) => {
      if (!cancelled) {
        setDensity(clampPreset(typeof v === 'number' ? v : densityBytes));
      }
    };
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local
          .get(['qrFrameDensityBytes'])
          .then(r => apply(r?.['qrFrameDensityBytes']));
      } else {
        apply(undefined);
      }
    } catch {
      apply(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [densityBytes]);

  const persistDensity = (n: number) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        void chrome.storage.local.set({ qrFrameDensityBytes: n });
      }
    } catch {
      /* non-extension environment */
    }
  };
  const changeDensity = useCallback((n: number) => {
    setDensity(clampPreset(n));
    persistDensity(clampPreset(n));
  }, []);

  // Re-fountain UR frames at the chosen density when a raw source is available.
  useEffect(() => {
    if (!urSource || urSource.bytes.byteLength === 0) {
      setUrDensityFrames(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const mod = await import(/* webpackMode: "eager" */ '@repo/zcash-wasm');
        const m = mod as {
          default: (opts?: unknown) => Promise<unknown>;
          ur_encode_frames: (bytes: Uint8Array, type: string, fragSize: number) => string;
        };
        await m.default();
        const json = (m.ur_encode_frames as (b: Uint8Array, t: string, f: number) => string)(
          urSource.bytes,
          urSource.urType,
          density,
        );
        const frames = JSON.parse(json) as string[];
        if (!cancelled) {
          setUrDensityFrames(frames);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'failed to re-fountain frames');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [density, urSource]);

  const canReDensify = Boolean(urSource) || Boolean(data);

  // Effective frame list:
  //  UR-source → re-encoded frames (fall back to urFrames until regenerated)
  //  data      → legacy P-frames at the chosen density
  //  else      → as-supplied urFrames
  const frames = useMemo(() => {
    if (urSource) {
      return urDensityFrames ?? urFrames ?? [];
    }
    if (urFrames && urFrames.length > 0) {
      return urFrames;
    }
    if (!data || !urType) {
      return [];
    }
    try {
      return buildFrames(data, urType, bytesToB64Chars(density));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to encode payload');
      return [];
    }
  }, [data, urFrames, urType, density, urSource, urDensityFrames]);

  // Fullscreen QR: a weak phone camera (e.g. Pixel 3) scanning a laptop screen
  // needs the biggest possible target. Tap the QR to blow it up to the full
  // viewport; the modules get much larger so it locks far faster.
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 360,
    h: typeof window !== 'undefined' ? window.innerHeight : 640,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);
  // Square, minus a small margin so it never overflows either axis.
  const fullscreenSize = Math.max(240, Math.min(viewport.w, viewport.h) - 24);
  const renderSize = fullscreen ? fullscreenSize : size;

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) {
      return;
    }
    const idx = frameIndexRef.current % frames.length;
    frameIndexRef.current = idx + 1;
    setCurrentFrame(idx + 1);
    QRCode.toCanvas(
      canvas,
      frames[idx],
      {
        width: renderSize,
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
  }, [frames, renderSize]);

  useEffect(() => {
    if (frames.length === 0) {
      return;
    }
    renderFrame();
    if (frames.length > 1) {
      timerRef.current = setInterval(renderFrame, intervalMs);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [renderFrame, intervalMs, frames.length]);

  const byteCount = totalBytes ?? data?.length ?? 0;
  const frameEstimate =
    byteCount > 0 && density > 0 ? Math.ceil(byteCount / density) : frames.length;
  const qrVersion = estimateQrVersion(density);

  if (error) {
    return (
      <div className='flex flex-col items-center gap-2 p-4'>
        <p className='text-xs text-red-400'>{error}</p>
      </div>
    );
  }

  // The canvas element is the same node in both layouts; only the wrapper
  // styling and the render size change, so the animation loop keeps running.
  const qrBlock = (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black p-2'
          : 'cursor-zoom-in'
      }
      onClick={() => setFullscreen(f => !f)}
      role='button'
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          setFullscreen(f => !f);
        }
      }}
      title={fullscreen ? 'tap to shrink' : 'tap to enlarge for scanning'}
    >
      <div className='relative rounded-lg bg-white p-3'>
        <canvas ref={canvasRef} />
        {frames.length > 1 && (
          <div className='absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-label text-white font-mono'>
            {currentFrame}/{frames.length}
          </div>
        )}
      </div>
      {fullscreen && (
        <p className='text-xs text-white/60'>tap anywhere to close · {currentFrame}/{frames.length}</p>
      )}
    </div>
  );

  return (
    <div className='flex flex-col items-center gap-3'>
      {title && <h3 className='text-sm font-medium text-fg'>{title}</h3>}

      {qrBlock}

      {!fullscreen && (
        <button
          type='button'
          onClick={() => setFullscreen(true)}
          className='flex items-center gap-1 text-label text-fg-muted hover:text-fg-high transition-colors'
        >
          <span className='i-ph-arrows-out size-3' />
          enlarge to full screen
        </button>
      )}

      {frames.length > 1 && (
        <div className='flex items-center gap-2 text-label text-fg-muted'>
          <span className='i-ph-circle-notch size-3 animate-spin' />
          scanning — hold camera steady
        </div>
      )}

      {/* ── QR speed (ms/frame) ── */}
      {showSpeedControl && frames.length > 1 && (
        <label className='flex w-full max-w-xs flex-col gap-1 text-label text-fg-muted'>
          <div className='flex items-center justify-between'>
            <span className='flex items-center gap-1'>
              <span className='i-ph-gauge size-3' />
              QR speed
            </span>
            <span className='font-mono'>{Math.round(1000 / Math.max(intervalMs, 1))} fps</span>
          </div>
          {/*
            The slider value is ms-per-frame, where a SMALLER number is FASTER.
            Bind it inverted (min+max - intervalMs) so dragging right lowers the
            interval = speeds up, matching the slow→fast labels below.
          */}
          <input
            type='range'
            min={60}
            max={700}
            step={20}
            value={760 - intervalMs}
            onChange={e => changeSpeed(760 - Number(e.target.value))}
            className='w-full accent-zigner-gold'
          />
          <div className='flex justify-between text-xs opacity-70'>
            <span>slow</span>
            <span>fast</span>
          </div>
        </label>
      )}

      {/* ── QR density (payload bytes / frame) ── */}
      {showDensityControl && frames.length > 1 && canReDensify && (
        <div className='flex w-full max-w-xs flex-col gap-1 text-label text-fg-muted'>
          <div className='flex items-center justify-between'>
            <span className='flex items-center gap-1'>
              <span className='i-ph-grid-four size-3' />
              QR density
            </span>
            <span className='font-mono'>
              ≈ v{qrVersion} · ~{frameEstimate.toLocaleString()} frames
            </span>
          </div>
          <div className='grid grid-cols-4 gap-1'>
            {QR_DENSITY_PRESETS.map(preset => {
              const active = density === preset.bytes;
              return (
                <button
                  key={preset.key}
                  type='button'
                  onClick={() => changeDensity(preset.bytes)}
                  className={`rounded-md border px-1 py-1 text-center text-xs transition-colors ${
                    active
                      ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                      : 'border-border-soft text-fg-muted hover:border-zigner-gold/50'
                  }`}
                >
                  <span className='block font-medium capitalize'>{preset.label}</span>
                  <span className='block opacity-70'>
                    {preset.bytes < 1000 ? `${preset.bytes}B` : `${preset.bytes / 1000}KB`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className='flex justify-between text-xs opacity-70'>
            <span>fewer bytes · more frames</span>
            <span>more bytes · fewer frames</span>
          </div>
        </div>
      )}

      {description && <p className='text-xs text-fg-muted text-center max-w-xs'>{description}</p>}

      <p className='text-label text-fg-muted'>
        {byteCount.toLocaleString()} bytes · {frames.length} frame
        {frames.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
