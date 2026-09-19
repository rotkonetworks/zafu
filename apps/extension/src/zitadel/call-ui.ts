/**
 * Voice/video call panel for a zitadel DM, built on @zafu/media.
 *
 * The call rides the SAME @zafu/zid Noise channel as the DM chat: SDP/ICE are
 * framed with MEDIA_SIGNAL_TAG and carried over the E2EE (hybrid-PQ) channel, so
 * call setup is itself post-quantum encrypted. Media (audio/video RTP) is direct
 * P2P once ICE connects.
 *
 * Vanilla DOM to match zitadel (no UI framework). @zafu/media exposes reactive
 * state as Readable<T> (getter + .subscribe), which we bind imperatively here.
 *
 * Imported from the package's specific modules (not its index) so blur.ts - and
 * its optional @mediapipe/tasks-vision dep - is never pulled in. Calls are
 * audio/video only for now; wiring createVideoBlur is a later, additive step.
 */

/* eslint-disable import/no-relative-packages -- @zafu/media publishes no subpath exports yet; the workspace symlink is blocked on an unrelated registry pin, so we import source directly like main.tsx does for @zafu/zid */
import { createCall } from '../../../../packages/media/src/call';
import { zidSignaling } from '../../../../packages/media/src/signaling';
import type { ZidChannel } from '../../../../packages/zid/src';
/* eslint-enable import/no-relative-packages */

/**
 * Frame tag for media SDP/ICE on the shared DM channel. Chosen in 0x80-0xBF
 * (UTF-8 continuation range): a valid UTF-8 chat message can never begin with
 * such a byte, so media frames and chat frames never collide. zitadel's DM
 * message handler drops frames with this leading byte.
 */
export const MEDIA_SIGNAL_TAG = 0x80;

export interface CallUi {
  /** the panel element to insert into the DM view. */
  el: HTMLElement;
  /** stop media, close the connection, detach. */
  destroy(): void;
}

export function createCallUi(opts: {
  channel: ZidChannel;
  localPubkey: string;
  peerPubkey: string;
  peerNick: string;
}): CallUi {
  const { channel, localPubkey, peerPubkey, peerNick } = opts;

  const call = createCall({
    signaling: zidSignaling(channel, MEDIA_SIGNAL_TAG),
    // perfect negotiation: exactly one side polite. Same lexicographic rule
    // both peers can compute independently (mirrors the Noise initiator rule).
    polite: localPubkey < peerPubkey,
  });

  const unsubscribers: (() => void)[] = [];

  // -- DOM --
  const el = document.createElement('div');
  el.style.cssText =
    'border:1px solid #333;border-radius:8px;padding:8px;margin:8px 0;background:#0d0d0d;font-size:12px';

  const title = document.createElement('div');
  title.textContent = `call - ${peerNick}`;
  title.style.cssText = 'color:#8be4d9;margin-bottom:6px';
  el.appendChild(title);

  const videos = document.createElement('div');
  videos.style.cssText = 'position:relative;display:flex;justify-content:center;background:#000;border-radius:6px;min-height:120px;overflow:hidden';
  const remoteVideo = document.createElement('video');
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideo.style.cssText = 'max-width:100%;max-height:240px';
  const localVideo = document.createElement('video');
  localVideo.autoplay = true;
  localVideo.playsInline = true;
  localVideo.muted = true; // never monitor your own mic
  localVideo.style.cssText =
    'position:absolute;bottom:6px;right:6px;width:80px;border:1px solid #333;border-radius:4px;background:#000';
  videos.appendChild(remoteVideo);
  videos.appendChild(localVideo);
  el.appendChild(videos);

  const status = document.createElement('div');
  status.style.cssText = 'color:#888;margin:6px 0;min-height:14px';
  el.appendChild(status);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
  el.appendChild(controls);

  const mkBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'padding:4px 8px;border:1px solid #333;border-radius:4px;background:#161616;color:#ddd;cursor:pointer;font-size:12px';
    b.onclick = onClick;
    controls.appendChild(b);
    return b;
  };

  // Opt-in gate: direct P2P media reveals your IP (and video, your face) to the
  // peer. Nothing touches getUserMedia until the user clicks this.
  const startBtn = mkBtn('start call (reveals your IP to peer)', () => {
    call.acknowledge();
    void call.toggleMic();
  });
  const micBtn = mkBtn('mic', () => void call.toggleMic());
  const camBtn = mkBtn('camera', () => void call.toggleCam());
  const hangBtn = mkBtn('hang up', () => call.revoke());

  const errBar = document.createElement('div');
  errBar.style.cssText = 'color:#f88;margin-top:6px;display:none';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'retry';
  retryBtn.style.cssText =
    'margin-left:8px;padding:2px 6px;border:1px solid #533;border-radius:4px;background:#1a0d0d;color:#f88;cursor:pointer';
  retryBtn.onclick = () => void call.retry();
  el.appendChild(errBar);

  // -- bind reactive state -> DOM --
  const sub = <T>(r: { (): T; subscribe(fn: (v: T) => void): () => void }, fn: (v: T) => void) => {
    fn(r()); // initial
    unsubscribers.push(r.subscribe(fn));
  };

  sub(call.localStream, s => {
    localVideo.srcObject = s;
    localVideo.style.display = s && s.getVideoTracks().length ? 'block' : 'none';
  });
  sub(call.remoteStream, s => {
    remoteVideo.srcObject = s;
  });

  const refreshControls = () => {
    const on = call.acknowledged();
    startBtn.style.display = on ? 'none' : 'inline-block';
    micBtn.style.display = on ? 'inline-block' : 'none';
    camBtn.style.display = on ? 'inline-block' : 'none';
    hangBtn.style.display = on ? 'inline-block' : 'none';
    micBtn.textContent = call.micEnabled() ? 'mute mic' : 'unmute mic';
    camBtn.textContent = call.camEnabled() ? 'stop camera' : 'start camera';
  };
  sub(call.acknowledged, refreshControls);
  sub(call.micEnabled, refreshControls);
  sub(call.camEnabled, refreshControls);

  const refreshStatus = () => {
    if (call.incomingPending()) {
      status.textContent = `${peerNick} wants to start a call - click "start call" to join`;
      status.style.color = '#8be4d9';
    } else if (call.connected()) {
      status.textContent = 'connected (direct P2P, end-to-end)';
      status.style.color = '#6c6';
    } else if (call.acknowledged()) {
      status.textContent = 'connecting...';
      status.style.color = '#888';
    } else {
      status.textContent = 'not in a call';
      status.style.color = '#888';
    }
  };
  sub(call.connected, refreshStatus);
  sub(call.incomingPending, refreshStatus);
  sub(call.acknowledged, refreshStatus);

  sub(call.lastError, e => {
    if (e) {
      errBar.textContent = e.message;
      errBar.appendChild(retryBtn);
      errBar.style.display = 'block';
    } else {
      errBar.style.display = 'none';
    }
  });

  return {
    el,
    destroy() {
      for (const u of unsubscribers) {
        u();
      }
      call.cleanup();
      el.remove();
    },
  };
}
