# @zafu/media

Framework-agnostic P2P media primitives for [zafu](https://zafu.pro) - opt-in WebRTC voice/video with perfect negotiation, Meet-style background blur, and pluggable signaling.

```sh
npm install @zafu/media
```

## What it is

A call is **direct P2P**: audio and video never touch a server. Only the SDP/ICE setup has to travel, and you inject that transport - so pointing it at a `@zafu/zid` Noise channel makes call setup end-to-end, post-quantum encrypted as well.

Nothing heavy is dragged in unless you ask for it. No UI framework is imported - state is exposed as `Readable<T>` (a getter that is also `.subscribe`-able). Blur is an injected factory. `@mediapipe/tasks-vision` is an _optional_ peer dependency, loaded lazily and only when you pass `blur`.

## Quick start

```ts
import { createCall, createVideoBlur, zidSignaling } from '@zafu/media';

const call = createCall({
  signaling: zidSignaling(zidChannel), // SDP/ICE over the E2EE channel
  polite: myId < peerId, // exactly one side must be polite
  blur: () => createVideoBlur(), // optional - omit it and blur costs nothing
});

call.acknowledge(); // consent gate - nothing connects before this
await call.toggleMic();
await call.toggleCam();

call.remoteStream.subscribe(s => {
  if (s) videoEl.srcObject = s;
});
```

## Opt-in, or nothing happens

Media is hard opt-in, because a direct connection reveals each peer's IP to the other. Until `acknowledge()` is called:

- `getUserMedia` is never called and no `RTCPeerConnection` is created;
- inbound SDP/ICE is **ignored**, so a remote peer cannot force a connection (or a candidate-gathering IP probe);
- `incomingPending` flips to `true` when the peer offers - render your own prompt, then `acknowledge()` or `dismissIncoming()`.

`revoke()` stops the tracks, closes the connection and re-arms the gate; the `Call` stays subscribed, so a later `acknowledge()` can connect again. `cleanup()` is the final teardown - it also unsubscribes from signaling.

## ICE defaults (privacy-first)

`iceServers` defaults to `[]` - host candidates only. No TURN (it would relay your media through a server, defeating "media is direct") and no third-party STUN (it would hand a third party your reflexive IP). This connects on reachable networks and may fail behind symmetric NAT; that is the deliberate default. Pass your own `iceServers` - a self-hosted STUN, typically - to change it.

## Background blur (optional)

`createVideoBlur()` segments each outgoing frame (MediaPipe selfie segmenter) and composites a sharp person over a blurred or replaced background, exposed as a canvas `MediaStream` and swapped into the sender with `replaceTrack()` - no renegotiation.

```ts
const blur = createVideoBlur({ assetBase: '/mediapipe', blurPx: 14 });
const call = createCall({ signaling, polite, blur: () => blur });

await call.setBlurMode('blur'); // 'off' | 'blur' | 'image'
call.setBlurImage(myImageBitmap); // used by 'image' mode
```

**Assets are same-origin.** The wasm runtime and the `.tflite` model are served from `assetBase` (default `/mediapipe`) - vendor `@mediapipe/tasks-vision`'s wasm directory and `selfie_segmenter.tflite` there. Nothing is fetched from a CDN. MediaPipe compiles wasm at load time, so a strict CSP needs `script-src 'wasm-unsafe-eval'` (this does not re-open JS `eval`).

If the model fails to initialise, `setBlurMode` rejects, `blurUnavailable` goes true, and the **raw camera track keeps being sent** - never a black frame.

## Errors

`lastError` carries the last unrecovered failure, tagged with the step to re-run and a kind you can branch on:

```ts
call.lastError.subscribe(e => {
  if (e) showBanner(e.message); // { step: 'mic'|'cam'|'connect', kind: 'denied'|'busy'|'notfound'|'negotiation'|'unknown' }
});
await call.retry(); // re-runs the failed step; idempotent
call.clearError(); // or just dismiss the banner
```

## Bridging to your framework

```ts
// React - Readable is a getter plus a subscribe, i.e. exactly useSyncExternalStore's shape
const micOn = useSyncExternalStore(call.micEnabled.subscribe, call.micEnabled);

// SolidJS / plain JS
const stop = call.connected.subscribe(up => setState({ up }));
```

## Signaling

`Signaling` is `send(msg)` + `onSignal(handler)` over two message kinds: `_sdp` and `_ice`. `zidSignaling(channel, tag = 0xf0)` bridges a `@zafu/zid` `ZidChannel` (or anything with `send`/`on('message')`) by JSON-framing those messages behind a one-byte tag, so media control never collides with your own chat frames - frames that do not start with the tag are left untouched for the app's own handler.

Written your own transport? Implement the two methods:

```ts
const signaling: Signaling = {
  send: msg => socket.send(JSON.stringify(msg)),
  onSignal: handler => {
    socket.on('message', handler);
    return () => socket.off('message', handler);
  },
};
```

One `Call` talks to exactly one peer.

## Services (composition)

Signaling also composes with [`@zafu/service`](https://www.npmjs.com/package/@zafu/service)

- the repo's one composition convention (Eriksen, "Your Server as a Function") -
  so SDP/ICE can ride any `Service` the app already has.

```ts
import { compose, timeout, trace } from '@zafu/service';
import { callSignalService, serviceSignaling, signalingStrategy } from '@zafu/media';

// outbound: a signal -> Service<MediaSignal, void>
const send = callSignalService(signaling);

// a named filter stack (trace + timeout; deliberately NO retry - replaying an
// SDP/ICE frame can reorder or duplicate a negotiation step):
const patient = signalingStrategy('patient')(send);

// both halves as a Signaling, when the inbound source is yours to inject:
const bridged = serviceSignaling(send, handler => {
  socket.on('message', handler);
  return () => socket.off('message', handler);
});
```

`Signaling.send` is void, so `serviceSignaling` drops a rejected outbound
service - there is nowhere to report it. Use `callSignalService` directly when
you need the promise (and filters around it).

## API

| Export                                 | Purpose                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `createCall(options)`                  | Start a call session → `Call`. `options`: `signaling`, `polite`, `iceServers?`, `video?` (default 320x240 front camera), `blur?`. |
| `createVideoBlur(options?)`            | Background processing for an outgoing track → `VideoBlur`. `options`: `assetBase?`, `modelFile?`, `blurPx?`.                      |
| `zidSignaling(channel, tag?)`          | Bridge a byte channel into `Signaling` for SDP/ICE.                                                                               |
| `callSignalService(signaling)`         | Outbound signaling as a `Service<MediaSignal, void>`.                                                                             |
| `serviceSignaling(service, subscribe)` | Build a `Signaling` from an outbound `Service` plus a subscriber for the inbound half.                                            |
| `signalingStrategy(name)`              | A named `Filter` stack (`'default'` \| `'patient'`) for the outbound signal service - trace + timeout, never retry.               |
| `writable(initial)`                    | `[read, write]` - the reactive primitive the call state is built on, if you want your own.                                        |

`Call`: `localStream`, `remoteStream`, `micEnabled`, `camEnabled`, `connected`, `acknowledged`, `incomingPending`, `blurMode`, `blurUnavailable`, `lastError` (all `Readable`), plus `acknowledge()`, `revoke()`, `dismissIncoming()`, `toggleMic()`, `toggleCam()`, `setBlurMode(mode)`, `setBlurImage(img)`, `retry()`, `clearError()`, `cleanup()`.

`VideoBlur`: `outputTrack()`, `mode()`, `ready()`, `setMode(mode, source?)`, `setBackgroundImage(img)`, `stop()`.

## License

MIT
