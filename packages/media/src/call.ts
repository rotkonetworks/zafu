/**
 * Opt-in P2P voice/video call primitive (framework-agnostic).
 *
 * Ported from the poker media layer. All reactive state is exposed as
 * `Readable<T>` (a getter that is also `.subscribe`-able), so it drops into
 * SolidJS as a signal, bridges to React via useSyncExternalStore, or is polled
 * from plain JS. No UI framework is imported.
 *
 * PRIVACY / OPT-IN. Media connects the two clients DIRECTLY (audio/video never
 * touches a server), which necessarily reveals each peer's IP to the other.
 * Therefore media is HARD opt-in: nothing calls getUserMedia and no
 * RTCPeerConnection is created until `acknowledge()`. Incoming SDP/ICE is
 * ignored until then, so a remote peer cannot force a connection (or a
 * candidate-gathering IP probe) before we consent. `revoke()` tears down and
 * re-arms the gate.
 *
 * ICE default: EMPTY iceServers (host candidates only) - no TURN (would relay
 * media through a server, defeating "media is direct"), no third-party STUN
 * (would hand a third party the reflexive IP). Connects on reachable networks;
 * may fail behind symmetric NAT - the privacy-first default. Pass your own
 * `iceServers` (e.g. a self-hosted STUN) to change this.
 */

import type { BlurMode, VideoBlur } from './blur-types';
import type { MediaSignal, Signaling } from './signaling';
import { writable, type Readable } from './store';

export type MediaErrorStep = 'mic' | 'cam' | 'connect';
export type MediaErrorKind = 'denied' | 'busy' | 'notfound' | 'negotiation' | 'unknown';
export interface MediaError {
  step: MediaErrorStep;
  kind: MediaErrorKind;
  message: string;
}

export interface CallOptions {
  /** SDP/ICE transport. See Signaling / zidSignaling. */
  signaling: Signaling;
  /**
   * Perfect-negotiation role: exactly one side must be `polite`. A stable rule
   * both peers can compute independently is e.g. `myId < peerId`.
   */
  polite: boolean;
  /** ICE servers. Default [] (host candidates only, privacy-first). */
  iceServers?: RTCIceServer[];
  /** outgoing video constraints. Default 320x240 front camera. */
  video?: MediaTrackConstraints;
  /**
   * Background-blur pipeline factory (e.g. () => createVideoBlur()). Optional -
   * omit it and blur controls become no-ops (and the mediapipe dep is never
   * loaded). Injected so a consumer that does not want blur pays nothing.
   */
  blur?: () => VideoBlur;
}

export interface Call {
  localStream: Readable<MediaStream | null>;
  remoteStream: Readable<MediaStream | null>;
  micEnabled: Readable<boolean>;
  camEnabled: Readable<boolean>;
  connected: Readable<boolean>;
  /** last unrecovered error (tagged with the step to re-run), or null. */
  lastError: Readable<MediaError | null>;
  /** clear the error banner without retrying. */
  clearError: () => void;
  /** re-run the step that last failed. Idempotent; the "never get stuck" button. */
  retry: () => Promise<void>;
  /** true once the user consented to direct-P2P media + IP exposure. */
  acknowledged: Readable<boolean>;
  /** record consent; media stays inert until this is called. */
  acknowledge: () => void;
  /** withdraw consent: stop tracks, close the peer connection, re-arm the gate. */
  revoke: () => void;
  /** true when the peer offered but we have not opted in (drives a prompt). */
  incomingPending: Readable<boolean>;
  /** dismiss the incoming-media prompt without opting in. */
  dismissIncoming: () => void;
  /** outgoing-webcam background mode. */
  blurMode: Readable<BlurMode>;
  /** change the outgoing-webcam background mode (falls back to raw on failure). */
  setBlurMode: (m: BlurMode) => Promise<void>;
  /** background image for 'image' mode. */
  setBlurImage: (img: HTMLImageElement | ImageBitmap | null) => void;
  /** true if blur was requested but the model failed to init (sending raw). */
  blurUnavailable: Readable<boolean>;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  /** fully stop media and close the connection (also re-arms the gate). */
  cleanup: () => void;
}

const DEFAULT_VIDEO: MediaTrackConstraints = { width: 320, height: 240, facingMode: 'user' };

export function createCall(options: CallOptions): Call {
  const { signaling, polite } = options;
  const iceServers = options.iceServers ?? [];
  const videoConstraints = options.video ?? DEFAULT_VIDEO;

  const [localStream, setLocalStream] = writable<MediaStream | null>(null);
  const remoteStreamsMap = new Map<string, MediaStream>();
  const PEER = 'peer';
  const [remoteStream, setRemoteStream] = writable<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = writable(false);
  const [camEnabled, setCamEnabled] = writable(false);
  const [connected, setConnected] = writable(false);
  const [acknowledged, setAcknowledged] = writable(false);
  const [incomingPending, setIncomingPending] = writable(false);
  const [blurMode, setBlurModeState] = writable<BlurMode>('off');
  const [blurUnavailable, setBlurUnavailable] = writable(false);
  const [lastError, setLastError] = writable<MediaError | null>(null);

  function classifyError(step: MediaErrorStep, e: unknown): MediaError {
    const name = (e as { name?: string })?.name ?? '';
    let kind: MediaErrorKind = 'unknown';
    let message: string;
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        kind = 'denied';
        message =
          step === 'cam'
            ? 'Camera permission was blocked. Allow camera access, then retry.'
            : 'Microphone permission was blocked. Allow mic access, then retry.';
        break;
      case 'NotReadableError':
      case 'AbortError':
        kind = 'busy';
        message = `${step === 'cam' ? 'Camera' : 'Microphone'} is in use by another app or tab. Close it, then retry.`;
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        kind = 'notfound';
        message =
          step === 'cam'
            ? 'No camera found. Connect one, then retry.'
            : 'No microphone found. Connect one, then retry.';
        break;
      default:
        message = `Could not start ${step === 'cam' ? 'camera' : step === 'mic' ? 'microphone' : 'the connection'}. Retry.`;
    }
    return { step, kind, message };
  }

  let pc: RTCPeerConnection | null = null;
  let makingOffer = false;
  let ignoreOffer = false;
  const blur = options.blur?.() ?? null;
  // The UNPROCESSED camera track, kept so we can revert to it / restart / stop.
  let rawCamTrack: MediaStreamTrack | null = null;

  function ensurePeerConnection(): RTCPeerConnection {
    if (pc) {
      return pc;
    }
    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = e => {
      if (e.candidate) {
        signaling.send({ t: '_ice', d: { candidate: e.candidate.toJSON() } });
      }
    };

    pc.ontrack = () => {
      // Rebuild the remote stream from ALL current receiver tracks with a fresh
      // MediaStream reference, so a later renegotiation (video added after an
      // audio-only call) actually re-binds the consumer's <video> element.
      const stream = new MediaStream();
      for (const r of pc!.getReceivers()) {
        if (r.track) {
          stream.addTrack(r.track);
        }
      }
      remoteStreamsMap.set(PEER, stream);
      setRemoteStream(stream);
    };

    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      setConnected(st === 'connected');
      if (st === 'connected') {
        if (lastError()?.step === 'connect') {
          setLastError(null);
        }
      } else if (st === 'failed') {
        setLastError({
          step: 'connect',
          kind: 'negotiation',
          message: 'The direct connection failed (restrictive network). Retry to reconnect.',
        });
      }
    };

    // perfect negotiation
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc!.setLocalDescription();
        signaling.send({ t: '_sdp', d: { sdp: pc!.localDescription!.toJSON() } });
      } catch {
        setLastError({
          step: 'connect',
          kind: 'negotiation',
          message: 'Could not negotiate the media connection. Retry.',
        });
      } finally {
        makingOffer = false;
      }
    };

    return pc;
  }

  // Acquire audio and/or video, MERGING into any existing localStream. Each kind
  // is requested separately so a failure is attributable to the exact device.
  async function getLocalMedia(audio: boolean, video: boolean): Promise<MediaStream> {
    let stream = localStream();
    let changed = false;

    if (audio && !stream?.getAudioTracks().length) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!stream) {
        stream = new MediaStream();
      }
      s.getAudioTracks().forEach(t => stream!.addTrack(t));
      changed = true;
    }
    if (video && !stream?.getVideoTracks().length) {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      if (!stream) {
        stream = new MediaStream();
      }
      s.getVideoTracks().forEach(t => stream!.addTrack(t));
      changed = true;
    }
    if (!stream) {
      stream = new MediaStream();
    }
    if (changed) {
      setLocalStream(new MediaStream(stream.getTracks()));
    }
    return localStream()!;
  }

  function addTracksToPC(stream: MediaStream) {
    const conn = ensurePeerConnection();
    const existingSenders = conn.getSenders();
    for (const track of stream.getTracks()) {
      if (!existingSenders.some(s => s.track?.id === track.id)) {
        conn.addTrack(track, stream);
      }
    }
  }

  function videoSender(): RTCRtpSender | null {
    return pc?.getSenders().find(s => s.track?.kind === 'video') ?? null;
  }

  // Swap the video track the peer receives WITHOUT renegotiation, and mirror it
  // into localStream so the local preview matches what we send.
  async function swapVideoTrack(next: MediaStreamTrack) {
    const sender = videoSender();
    if (sender && sender.track?.id !== next.id) {
      try {
        await sender.replaceTrack(next);
      } catch (e) {
        console.warn('[zafu-media] replaceTrack failed:', e);
      }
    }
    const stream = localStream();
    if (stream) {
      const cur = stream.getVideoTracks()[0];
      if (cur && cur.id !== next.id) {
        stream.removeTrack(cur);
        stream.addTrack(next);
        setLocalStream(new MediaStream(stream.getTracks()));
      }
    }
  }

  async function applyBlurMode(mode: BlurMode) {
    setBlurModeState(mode);
    setBlurUnavailable(false);
    if (!blur) {
      return; // no blur pipeline injected - controls are inert
    }
    if (!camEnabled() || !rawCamTrack) {
      return; // remembered; applied when the cam turns on
    }
    if (mode === 'off') {
      await blur.setMode('off');
      await swapVideoTrack(rawCamTrack);
      return;
    }
    try {
      await blur.setMode(mode, rawCamTrack);
      const out = blur.outputTrack();
      if (out) {
        await swapVideoTrack(out);
      } else {
        throw new Error('no processed track');
      }
    } catch {
      setBlurUnavailable(true);
      await swapVideoTrack(rawCamTrack);
    }
  }

  async function enableMic() {
    const stream = await getLocalMedia(true, camEnabled());
    addTracksToPC(stream);
    stream.getAudioTracks().forEach(t => {
      t.enabled = true;
    });
    setMicEnabled(true);
    if (lastError()?.step === 'mic') {
      setLastError(null);
    }
  }

  async function toggleMic() {
    if (!acknowledged()) {
      console.warn('[zafu-media] mic toggle blocked: not acknowledged');
      return;
    }
    if (micEnabled()) {
      localStream()
        ?.getAudioTracks()
        .forEach(t => {
          t.enabled = false;
        });
      setMicEnabled(false);
      if (lastError()?.step === 'mic') {
        setLastError(null);
      }
    } else {
      try {
        await enableMic();
      } catch (e) {
        setMicEnabled(false);
        setLastError(classifyError('mic', e));
      }
    }
  }

  async function enableCam() {
    const stream = await getLocalMedia(micEnabled(), true);
    rawCamTrack = stream.getVideoTracks()[0] ?? null;
    if (rawCamTrack) {
      rawCamTrack.enabled = true;
    }
    addTracksToPC(stream);
    setCamEnabled(true);
    if (lastError()?.step === 'cam') {
      setLastError(null);
    }
    if (blurMode() !== 'off') {
      await applyBlurMode(blurMode());
    }
  }

  async function toggleCam() {
    if (!acknowledged()) {
      console.warn('[zafu-media] cam toggle blocked: not acknowledged');
      return;
    }
    if (camEnabled()) {
      localStream()
        ?.getVideoTracks()
        .forEach(t => {
          t.enabled = false;
        });
      blur?.setMode('off').catch(() => {});
      setCamEnabled(false);
      if (lastError()?.step === 'cam') {
        setLastError(null);
      }
    } else {
      try {
        await enableCam();
      } catch (e) {
        setCamEnabled(false);
        setLastError(classifyError('cam', e));
      }
    }
  }

  // Incoming signaling. Ignored until opt-in: a remote offer would otherwise
  // create a PC and start ICE gathering, leaking our IP before we consented.
  async function handleSignal(msg: MediaSignal) {
    if (!acknowledged()) {
      if (msg.t === '_sdp' && msg.d.sdp?.type === 'offer') {
        setIncomingPending(true);
      }
      return;
    }
    if (msg.t === '_sdp') {
      const conn = ensurePeerConnection();
      const desc = new RTCSessionDescription(msg.d.sdp);
      const offerCollision =
        desc.type === 'offer' && (makingOffer || conn.signalingState !== 'stable');
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) {
        return;
      }
      if (offerCollision) {
        await conn.setLocalDescription({ type: 'rollback' });
      }
      await conn.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await conn.setLocalDescription();
        signaling.send({ t: '_sdp', d: { sdp: conn.localDescription!.toJSON() } });
      }
    }
    if (msg.t === '_ice') {
      const conn = ensurePeerConnection();
      try {
        await conn.addIceCandidate(new RTCIceCandidate(msg.d.candidate));
      } catch (e) {
        if (!ignoreOffer) {
          console.warn('[zafu-media] ICE error:', e);
        }
      }
    }
  }

  function teardown() {
    blur?.stop();
    rawCamTrack?.stop();
    rawCamTrack = null;
    localStream()
      ?.getTracks()
      .forEach(t => t.stop());
    setLocalStream(null);
    remoteStreamsMap.clear();
    setRemoteStream(null);
    pc?.close();
    pc = null;
    makingOffer = false;
    ignoreOffer = false;
    setMicEnabled(false);
    setCamEnabled(false);
    setConnected(false);
    setBlurUnavailable(false);
    setLastError(null);
  }

  async function retry() {
    const err = lastError();
    if (!err) {
      return;
    }
    setLastError(null);
    try {
      if (err.step === 'mic') {
        await enableMic();
      } else if (err.step === 'cam') {
        await enableCam();
      } else {
        if (pc && pc.connectionState !== 'closed') {
          try {
            pc.restartIce();
          } catch {
            /* fall through to rebuild */
          }
        }
        if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          const wasCam = camEnabled();
          pc?.close();
          pc = null;
          const stream = localStream();
          if (stream) {
            ensurePeerConnection();
            addTracksToPC(stream);
            if (blurMode() !== 'off' && wasCam) {
              await applyBlurMode(blurMode());
            }
          }
        }
      }
    } catch (e) {
      setLastError(classifyError(err.step, e));
    }
  }

  const unsubscribe = signaling.onSignal(msg => {
    void handleSignal(msg);
  });

  return {
    localStream,
    remoteStream,
    micEnabled,
    camEnabled,
    connected,
    lastError,
    clearError: () => setLastError(null),
    retry,
    acknowledged,
    acknowledge: () => {
      setAcknowledged(true);
      setIncomingPending(false);
    },
    revoke: () => {
      teardown();
      setAcknowledged(false);
      setIncomingPending(false);
    },
    incomingPending,
    dismissIncoming: () => setIncomingPending(false),
    blurMode,
    setBlurMode: applyBlurMode,
    setBlurImage: img => blur?.setBackgroundImage(img),
    blurUnavailable,
    toggleMic,
    toggleCam,
    cleanup: () => {
      unsubscribe();
      teardown();
      setAcknowledged(false);
      setIncomingPending(false);
    },
  };
}
