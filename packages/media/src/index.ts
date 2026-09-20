/**
 * @zafu/media - framework-agnostic P2P media primitives.
 *
 * Opt-in WebRTC voice/video with perfect negotiation, local Google-Meet-style
 * background blur, and pluggable signaling. Media is direct P2P; only SDP/ICE
 * setup rides the injected `Signaling`, so pairing it with a `@zafu/zid` Noise
 * channel (see `zidSignaling`) makes call setup end-to-end, post-quantum
 * encrypted. No UI framework is imported - state is exposed as `Readable<T>`
 * (a getter that is also `.subscribe`-able), so it adapts to SolidJS, React, or
 * plain JS. The consuming app builds its own UI and its own opt-in prompt.
 *
 * ```typescript
 * import { createCall, createVideoBlur, zidSignaling } from '@zafu/media';
 * const call = createCall({
 *   signaling: zidSignaling(zidChannel),   // SDP/ICE over the E2EE channel
 *   polite: myId < peerId,
 *   blur: () => createVideoBlur(),          // optional
 * });
 * call.acknowledge();                       // consent gate (IP exposure)
 * await call.toggleMic();
 * ```
 */

export { createCall } from './call';
export type { Call, CallOptions, MediaError, MediaErrorKind, MediaErrorStep } from './call';

export { createVideoBlur } from './blur';
export type { BlurMode, VideoBlur, VideoBlurOptions } from './blur';

export { zidSignaling } from './signaling';
export type { ByteChannel, MediaSignal, Signaling } from './signaling';

export { writable } from './store';
export type { Readable, Writable } from './store';
