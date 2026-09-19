/**
 * Google-Meet-style webcam BACKGROUND processing for an OUTGOING video track.
 *
 * Modes:
 *   - 'off'   : pass the raw camera track through unchanged (no processing).
 *   - 'blur'  : keep the person sharp, blur the background.
 *   - 'image' : keep the person sharp, replace the background with an image.
 *
 * A per-frame person/background segmentation mask (MediaPipe ImageSegmenter,
 * the selfie segmenter) composites a sharp foreground over a blurred/image
 * background on a canvas, exposed as a MediaStream via captureStream(). The
 * processed track is swapped into the RTCRtpSender via replaceTrack() - no
 * renegotiation.
 *
 * FULLY OFFLINE / STRICT-CSP: `@mediapipe/tasks-vision` is an OPTIONAL peer dep
 * loaded lazily, and the wasm runtime + .tflite model are served SAME-ORIGIN
 * from `assetBase` (default '/mediapipe'). The host app vendors those assets;
 * nothing is fetched from a CDN. MediaPipe compiles its wasm at load time, so a
 * strict CSP needs script-src 'wasm-unsafe-eval' (does not re-open JS eval).
 *
 * GRACEFUL FALLBACK: if the model fails to init, setMode() rejects and the
 * caller keeps sending the RAW track - never a black frame.
 */

// Type-only import keeps the heavy dep out of the initial chunk; the runtime
// import in ensureSegmenter() is what actually loads it, lazily.
import type { ImageSegmenter } from '@mediapipe/tasks-vision';
import type { BlurMode, VideoBlur, VideoBlurOptions } from './blur-types';

export type { BlurMode, VideoBlur, VideoBlurOptions } from './blur-types';

export function createVideoBlur(options: VideoBlurOptions = {}): VideoBlur {
  const BASE = options.assetBase ?? '/mediapipe';
  const MODEL_URL = `${BASE}/${options.modelFile ?? 'selfie_segmenter.tflite'}`;
  const BLUR_PX = options.blurPx ?? 10;

  let segmenter: ImageSegmenter | null = null;
  let initPromise: Promise<void> | null = null;
  let isReady = false;

  let currentMode: BlurMode = 'off';
  let sourceTrack: MediaStreamTrack | null = null;
  let bgImage: HTMLImageElement | ImageBitmap | null = null;

  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let maskCanvas: HTMLCanvasElement | null = null;
  let maskCtx: CanvasRenderingContext2D | null = null;
  let outStream: MediaStream | null = null;
  let rafId: number | null = null;
  let running = false;

  async function ensureSegmenter(): Promise<void> {
    if (isReady) {
      return;
    }
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      // Lazy dynamic import - separate chunk, not in the initial bundle, and the
      // optional peer dep is only required if blur is actually used.
      const vision = await import('@mediapipe/tasks-vision');
      const { FilesetResolver, ImageSegmenter: Segmenter } = vision;
      const fileset = await FilesetResolver.forVisionTasks(BASE);
      segmenter = await Segmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      isReady = true;
    })();
    try {
      await initPromise;
    } catch (e) {
      initPromise = null;
      isReady = false;
      console.warn('[zafu-media/blur] segmenter init failed, falling back to raw:', e);
      throw e;
    }
  }

  function ensureSurfaces(w: number, h: number) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: false });
    }
    if (!maskCanvas) {
      maskCanvas = document.createElement('canvas');
      maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      maskCanvas.width = w;
      maskCanvas.height = h;
    }
  }

  async function attachVideo(track: MediaStreamTrack): Promise<void> {
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
    }
    video.srcObject = new MediaStream([track]);
    await video.play().catch(() => {});
    if (!video.videoWidth) {
      await new Promise<void>(res => {
        const onMeta = () => {
          video?.removeEventListener('loadedmetadata', onMeta);
          res();
        };
        video?.addEventListener('loadedmetadata', onMeta);
      });
    }
  }

  function composite(mask: Float32Array, w: number, h: number) {
    if (!ctx || !canvas || !video || !maskCtx || !maskCanvas) {
      return;
    }

    // 1) RGBA mask image (alpha = person confidence).
    const imgData = maskCtx.createImageData(w, h);
    const data = imgData.data;
    for (let i = 0; i < mask.length; i++) {
      data[i * 4 + 3] = (mask[i] ?? 0) > 0.5 ? 255 : Math.round((mask[i] ?? 0) * 255);
    }
    maskCtx.putImageData(imgData, 0, 0);

    // 2) BACKGROUND layer (blurred frame or image).
    ctx.save();
    ctx.filter = 'none';
    if (currentMode === 'image' && bgImage) {
      drawCover(ctx, bgImage, w, h);
    } else {
      ctx.filter = `blur(${BLUR_PX}px)`;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.filter = 'none';
    }
    ctx.restore();

    // 3) Sharp foreground masked by alpha, composited on maskCanvas.
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-in';
    maskCtx.filter = 'none';
    maskCtx.drawImage(video, 0, 0, w, h);
    maskCtx.restore();

    // 4) Overlay the masked sharp foreground on the background layer.
    ctx.drawImage(maskCanvas, 0, 0, w, h);
  }

  function drawCover(
    c: CanvasRenderingContext2D,
    img: HTMLImageElement | ImageBitmap,
    w: number,
    h: number,
  ) {
    const iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width;
    const ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height;
    if (!iw || !ih) {
      return;
    }
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    c.drawImage(img as CanvasImageSource, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function loop() {
    if (!running || !video || !segmenter || !canvas || !ctx) {
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    if (video.readyState >= 2 && w && h) {
      try {
        const result = segmenter.segmentForVideo(video, performance.now());
        const masks = result.confidenceMasks;
        if (masks && masks[0]) {
          composite(masks[0].getAsFloat32Array(), w, h);
        } else {
          ctx.drawImage(video, 0, 0, w, h);
        }
        result.close();
      } catch {
        ctx.drawImage(video, 0, 0, w, h);
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (running) {
      return;
    }
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    running = false;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  async function setMode(m: BlurMode, source?: MediaStreamTrack): Promise<void> {
    if (source) {
      sourceTrack = source;
    }
    currentMode = m;

    if (m === 'off') {
      stopLoop();
      return;
    }
    if (!sourceTrack) {
      throw new Error('[zafu-media/blur] no source track');
    }

    await ensureSegmenter();
    await attachVideo(sourceTrack);
    const settings = sourceTrack.getSettings();
    const w = video?.videoWidth || settings.width || 320;
    const h = video?.videoHeight || settings.height || 240;
    ensureSurfaces(w, h);

    if (!outStream) {
      outStream = canvas!.captureStream(settings.frameRate || 30);
    }
    startLoop();
  }

  function stop() {
    stopLoop();
    outStream?.getTracks().forEach(t => t.stop());
    outStream = null;
    if (video) {
      video.srcObject = null;
      video = null;
    }
    canvas = null;
    ctx = null;
    maskCanvas = null;
    maskCtx = null;
    try {
      segmenter?.close();
    } catch {
      /* ignore */
    }
    segmenter = null;
    initPromise = null;
    isReady = false;
    currentMode = 'off';
    sourceTrack = null;
  }

  return {
    outputTrack: () => outStream?.getVideoTracks()[0] ?? null,
    mode: () => currentMode,
    setMode,
    setBackgroundImage: img => {
      bgImage = img;
    },
    ready: () => isReady,
    stop,
  };
}
