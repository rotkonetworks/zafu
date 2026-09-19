/**
 * Blur types with NO dependency on `@mediapipe/tasks-vision`.
 *
 * Kept separate from blur.ts (the implementation, which type-imports MediaPipe)
 * so that consumers using only createCall - and injecting or omitting blur - can
 * type-check without the optional mediapipe peer dep being installed.
 */

export type BlurMode = 'off' | 'blur' | 'image';

export interface VideoBlur {
  /** the processed outgoing track (canvas capture). null until a non-off setMode(). */
  outputTrack: () => MediaStreamTrack | null;
  /** current mode. */
  mode: () => BlurMode;
  /**
   * Switch modes at runtime. 'off' stops the processing loop and the caller
   * should replaceTrack() back to the raw camera track. Resolves once applied.
   * Throws if the segmenter could not initialise (caller falls back to raw).
   */
  setMode: (m: BlurMode, source?: MediaStreamTrack) => Promise<void>;
  /** provide/replace the background image (used by 'image' mode). */
  setBackgroundImage: (img: HTMLImageElement | ImageBitmap | null) => void;
  /** true once MediaPipe initialised successfully. */
  ready: () => boolean;
  /** tear everything down and release the model + canvas track. */
  stop: () => void;
}

export interface VideoBlurOptions {
  /**
   * Same-origin base URL holding the vendored MediaPipe wasm + model. The host
   * app copies `@mediapipe/tasks-vision`'s wasm dir and the selfie segmenter
   * `.tflite` here. Default '/mediapipe'.
   */
  assetBase?: string;
  /** model file name under assetBase. Default 'selfie_segmenter.tflite'. */
  modelFile?: string;
  /** background blur strength in px (canvas filter). Default 10. */
  blurPx?: number;
}
