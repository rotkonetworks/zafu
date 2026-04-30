// zitadel: shielded lobby served locally from the zafu extension.
// plain DOM, zero framework deps. WebSocket to relay.zk.bot.
// e2ee DMs via Noise IK channels, ZID identity from zafu keyring.

import { createNoiseChannel, type ZidChannel } from '../../../../packages/zid/src'
import type { SessionKey } from '../../../../packages/zid/src/noise-channel'

export const RELAY_WS = "wss://relay.zk.bot/ws";
const RELAY_ZID_WS = "wss://relay.zk.bot/ws/zid";

const C = {
  bg: "#0F0F1A", panel: "#16162A", border: "#2A2A4A",
  gold: "#F4B728", amber: "#D4991A", muted: "#6B6B8D",
  text: "#C8C8E0", bright: "#E8E8FF", green: "#4ADE80", red: "#F87171",
  cyan: "#22D3EE", purple: "#A78BFA", dm: "#FF79C6",
};

interface Msg {
  nick: string; text: string; time: string;
  system?: boolean; color?: string; dm?: boolean;
}

const NICK_COLORS = [C.gold, C.cyan, C.green, C.purple, C.red, "#60A5FA", "#FB923C", "#E879F9", "#FBBF24", "#34D399"];
function nickColor(n: string) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return NICK_COLORS[Math.abs(h) % NICK_COLORS.length]; }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return bytes;
}
function isHexPubkey(s: string): boolean { return /^[0-9a-f]{64}$/i.test(s); }
function shortPub(pub: string): string { return 'zid' + pub.slice(0, 6); }

const localStore = typeof chrome !== 'undefined' ? chrome?.storage?.local : undefined;
const sessionStore = typeof chrome !== 'undefined' ? chrome?.storage?.session : undefined;

// -- ZID identity resolution --

interface ZidInfo {
  loggedIn: boolean;
  pubkey?: string;       // full 64-char hex ed25519 pubkey
  privkey?: Uint8Array;  // ed25519 seed (32 bytes) - only available when unlocked
}

/** Read ZID pubkey from vault insensitive data (no password needed). */
async function getZidPubkey(): Promise<string | undefined> {
  if (!localStore) return undefined;
  try {
    const result: Record<string, unknown> = await new Promise(r => localStore.get('vaults', r));
    const vaults = result?.['vaults'] as Array<{ insensitive?: Record<string, unknown> }> | undefined;
    if (!vaults?.length) return undefined;
    // use the first vault's ZID pubkey
    for (const vault of vaults) {
      const zid = vault.insensitive?.['zid'] as string | undefined;
      if (zid) return zid;
    }
  } catch { /* not in extension context */ }
  return undefined;
}

/** Check if wallet is unlocked via session storage. */
async function isWalletUnlocked(): Promise<boolean> {
  if (!sessionStore) return false;
  try {
    const result: Record<string, unknown> = await new Promise(r => sessionStore.get('passwordKey', r));
    return !!result?.['passwordKey'];
  } catch { return false; }
}

/** Resolve ZID identity - pubkey from local storage, privkey from service worker. */
async function resolveZidIdentity(): Promise<ZidInfo> {
  const pubkey = await getZidPubkey();
  const unlocked = await isWalletUnlocked();

  if (!pubkey) return { loggedIn: false };

  if (unlocked) {
    // Request ed25519 keypair from service worker for Noise channel DH
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'zafu_zid_keypair',
        origin: 'zitadel',
      }) as { pubkey?: string; privkey?: string; error?: string } | undefined;
      if (resp?.privkey) {
        return {
          loggedIn: true,
          pubkey: resp.pubkey || pubkey,
          privkey: unhex(resp.privkey),
        };
      }
    } catch { /* service worker may not support this yet */ }
  }

  // pubkey-only mode - can identify but cannot initiate Noise channels
  return { loggedIn: true, pubkey };
}

// -- Room encryption (HKDF-derived room key) --

async function deriveRoomKey(roomName: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey('raw', enc.encode(roomName), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('zitadel-room-v1') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptRoomMsg(key: CryptoKey, text: string): Promise<{ ct: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(text);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  return { ct: btoa(String.fromCharCode(...ct)), iv: btoa(String.fromCharCode(...iv)) };
}

async function decryptRoomMsg(key: CryptoKey, ct64: string, iv64: string): Promise<string | null> {
  try {
    const ct = Uint8Array.from(atob(ct64), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(iv64), c => c.charCodeAt(0));
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.debug('[zitadel] room-key decrypt failed:', (e as Error).message,
      `(ct.len=${ct64.length}, iv.len=${iv64.length})`);
    return null;
  }
}

// -- encryption state label --

type EncState = 'e2ee' | 'room-key' | 'plain';

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function now() { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

function boot() {
  const root = document.getElementById('zitadel-root');
  if (!root) return;
  document.body.style.cssText = 'margin:0;padding:0;';
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap';
  document.head.appendChild(font);

  // init params (must be before state refs)
  const params = new URLSearchParams(location.search);
  const initialRoom = params.get('room') || 'zitadel';

  // state
  let nick = '...';
  let loggedIn = false;
  let zidPubkey: string | undefined;
  let zidPrivkey: Uint8Array | undefined;
  let currentRoom: string | null = null;
  let ws: WebSocket | null = null;
  let connected = false;
  let encState: EncState = 'plain';
  let roomKey: CryptoKey | null = null;
  const messagesPerRoom = new Map<string, Msg[]>();
  const joinedRooms = new Set<string>();
  const DEFAULT_CHANNELS = ['zitadel', 'support', 'dev'];
  const history: string[] = [];
  let histIdx = -1;

  // DM channels: pubkey -> ZidChannel
  const dmChannels = new Map<string, ZidChannel>();
  // nick -> pubkey mapping from relay user list
  const nickToPubkey = new Map<string, string>();
  // pubkey -> nick (reverse)
  const pubkeyToNick = new Map<string, string>();
  // DM messages stored under "dm:<pubkey>" key
  const DM_PREFIX = 'dm:';
  // track which DM we're viewing (null = room view)
  let activeDm: string | null = null;

  function roomMessages(): Msg[] {
    const key = activeDm ? (DM_PREFIX + activeDm) : (currentRoom || initialRoom);
    let arr = messagesPerRoom.get(key);
    if (!arr) { arr = []; messagesPerRoom.set(key, arr); }
    return arr;
  }

  function dmMessages(pubkey: string): Msg[] {
    const key = DM_PREFIX + pubkey;
    let arr = messagesPerRoom.get(key);
    if (!arr) { arr = []; messagesPerRoom.set(key, arr); }
    return arr;
  }

  // DOM - sidebar + main layout
  root.style.cssText = `background:${C.bg};color:${C.text};font-family:'IBM Plex Mono',monospace;font-size:14px;height:100vh;display:flex;`;
  const sidebar = mkEl('div', `width:180px;min-width:180px;background:${C.panel};border-right:1px solid ${C.border};display:flex;flex-direction:column;overflow-y:auto;`);
  const main = mkEl('div', `flex:1;display:flex;flex-direction:column;min-width:0;`);
  const topbar = mkEl('div', `background:${C.panel};border-bottom:1px solid ${C.border};padding:6px 12px;display:flex;align-items:center;gap:8px;`);
  const msgArea = mkEl('div', `flex:1;overflow-y:auto;padding:8px 12px;`);
  const statusEl = mkEl('div', `background:${C.panel};border-top:1px solid ${C.border};padding:4px 12px;font-size:11px;color:${C.muted};display:flex;gap:16px;`);
  const bar = mkEl('div', `background:${C.bg};border-top:1px solid ${C.border};padding:8px 12px;display:flex;align-items:center;gap:8px;`);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.autofocus = true;
  inp.placeholder = 'type a message... (/ for commands)';
  inp.style.cssText = `flex:1;background:transparent;border:none;outline:none;color:${C.bright};font-family:inherit;font-size:inherit;caret-color:${C.gold};`;
  bar.appendChild(inp);
  main.append(topbar, msgArea, statusEl, bar);
  root.append(sidebar, main);

  function mkEl(tag: string, css: string) { const e = document.createElement(tag); e.style.cssText = css; return e; }

  function addMsg(n: string, text: string, system = false, room?: string, dm = false) {
    const key = room || (activeDm ? (DM_PREFIX + activeDm) : (currentRoom || initialRoom));
    let arr = messagesPerRoom.get(key);
    if (!arr) { arr = []; messagesPerRoom.set(key, arr); }
    arr.push({ nick: n, text, time: now(), system, color: system ? undefined : nickColor(n), dm });
    render();
  }

  function addDmMsg(peerPubkey: string, fromNick: string, text: string, outgoing: boolean) {
    const key = DM_PREFIX + peerPubkey;
    let arr = messagesPerRoom.get(key);
    if (!arr) { arr = []; messagesPerRoom.set(key, arr); }
    arr.push({
      nick: fromNick,
      text,
      time: now(),
      dm: true,
      color: outgoing ? C.gold : C.dm,
    });
    render();
  }

  function switchRoom(room: string) {
    activeDm = null;
    if (room === currentRoom) { render(); return; }
    if (currentRoom) wsSend({ t: 'part' });
    wsSend({ t: 'join', room, nick });
  }

  function switchToDm(pubkey: string) {
    activeDm = pubkey;
    encState = dmChannels.has(pubkey) ? 'e2ee' : 'plain';
    render();
  }

  // -- DM channel management --

  async function openDmChannel(peerPubkey: string): Promise<ZidChannel | null> {
    // reuse existing channel
    const existing = dmChannels.get(peerPubkey);
    if (existing) return existing;

    if (!zidPubkey || !zidPrivkey) {
      addMsg('zitadel', 'cannot open DM - wallet not unlocked. unlock zafu for e2ee.', true);
      return null;
    }

    const session: SessionKey = {
      pubkey: zidPubkey,
      privkey: zidPrivkey,
      sign: async (data: Uint8Array) => {
        // sign with ed25519 via the imported noble library
        const { ed25519 } = await import('@noble/curves/ed25519');
        const sig = ed25519.sign(data, zidPrivkey!);
        return hex(sig);
      },
    };

    addMsg('zitadel', `opening e2ee channel to ${shortPub(peerPubkey)}...`, true, DM_PREFIX + peerPubkey);

    try {
      const ch = await createNoiseChannel(session, peerPubkey, RELAY_ZID_WS);

      ch.on('message', (data: Uint8Array) => {
        try {
          const text = new TextDecoder().decode(data);
          const peerNick = pubkeyToNick.get(peerPubkey) || shortPub(peerPubkey);
          addDmMsg(peerPubkey, peerNick, text, false);
        } catch { /* ignore malformed */ }
      });

      dmChannels.set(peerPubkey, ch);
      addMsg('zitadel', `[e2ee] channel established with ${shortPub(peerPubkey)}`, true, DM_PREFIX + peerPubkey);
      return ch;
    } catch (e) {
      addMsg('zitadel', `failed to open DM channel: ${e}`, true, DM_PREFIX + peerPubkey);
      return null;
    }
  }

  async function sendDm(peerPubkey: string, text: string) {
    let ch = dmChannels.get(peerPubkey);
    if (!ch) {
      ch = await openDmChannel(peerPubkey);
      if (!ch) return;
    }

    try {
      ch.send(text);
      addDmMsg(peerPubkey, nick, text, true);
    } catch (e) {
      addMsg('zitadel', `DM send failed: ${e}`, true, DM_PREFIX + peerPubkey);
    }
  }

  function closeDmChannel(peerPubkey: string) {
    const ch = dmChannels.get(peerPubkey);
    if (ch) {
      ch.close();
      dmChannels.delete(peerPubkey);
      addMsg('zitadel', `closed DM channel with ${shortPub(peerPubkey)}`, true, DM_PREFIX + peerPubkey);
      if (activeDm === peerPubkey) {
        activeDm = null;
        encState = roomKey ? 'room-key' : 'plain';
      }
      render();
    }
  }

  /** Resolve a nick or pubkey target to a pubkey. */
  function resolveTarget(target: string): string | null {
    if (isHexPubkey(target)) return target;
    // look up by nick
    const pub = nickToPubkey.get(target);
    if (pub) return pub;
    // try as partial zid prefix
    for (const [pub, n] of pubkeyToNick.entries()) {
      if (n === target || shortPub(pub) === target) return pub;
    }
    return null;
  }

  // -- render --

  function renderSidebar() {
    const room = currentRoom || initialRoom;
    const allRooms = [...new Set([...DEFAULT_CHANNELS, ...joinedRooms])];
    const dmPeers = [...dmChannels.keys()];

    sidebar.innerHTML = `
      <div style="padding:10px 12px;border-bottom:1px solid ${C.border};">
        <b style="color:${C.bright};font-size:13px;">channels</b>
      </div>
      ${allRooms.map(r => {
        const active = !activeDm && r === room;
        const bg = active ? C.border : 'transparent';
        const col = active ? C.bright : C.muted;
        return `<div class="ch" data-room="${esc(r)}" style="padding:5px 12px;cursor:pointer;background:${bg};color:${col};font-size:13px;transition:background 0.1s;">#${esc(r)}</div>`;
      }).join('')}
      ${dmPeers.length ? `<div style="padding:10px 12px;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};margin-top:4px;">
        <b style="color:${C.bright};font-size:13px;">DMs [e2ee]</b>
      </div>` : ''}
      ${dmPeers.map(pub => {
        const active = activeDm === pub;
        const bg = active ? C.border : 'transparent';
        const col = active ? C.dm : C.muted;
        const label = pubkeyToNick.get(pub) || shortPub(pub);
        return `<div class="dm-ch" data-pubkey="${esc(pub)}" style="padding:5px 12px;cursor:pointer;background:${bg};color:${col};font-size:12px;transition:background 0.1s;">[e2ee] ${esc(label)}</div>`;
      }).join('')}
      <div style="padding:8px 12px;margin-top:auto;border-top:1px solid ${C.border};">
        <div style="color:${C.muted};font-size:11px;">${esc(nick)}</div>
        <div style="color:${loggedIn ? C.green : C.muted};font-size:10px;">${loggedIn ? 'zid' : 'anon'}</div>
      </div>
    `;

    sidebar.querySelectorAll('.ch').forEach(el => {
      el.addEventListener('click', () => {
        const r = (el as HTMLElement).dataset['room'];
        if (r) switchRoom(r);
      });
      el.addEventListener('mouseenter', () => { (el as HTMLElement).style.background = C.border; });
      el.addEventListener('mouseleave', () => {
        const r = (el as HTMLElement).dataset['room'];
        if (!activeDm && r === (currentRoom || initialRoom)) return;
        (el as HTMLElement).style.background = 'transparent';
      });
    });

    sidebar.querySelectorAll('.dm-ch').forEach(el => {
      el.addEventListener('click', () => {
        const pub = (el as HTMLElement).dataset['pubkey'];
        if (pub) switchToDm(pub);
      });
      el.addEventListener('mouseenter', () => { (el as HTMLElement).style.background = C.border; });
      el.addEventListener('mouseleave', () => {
        const pub = (el as HTMLElement).dataset['pubkey'];
        if (activeDm !== pub) (el as HTMLElement).style.background = 'transparent';
      });
    });
  }

  function render() {
    const room = currentRoom || initialRoom;
    const msgs = roomMessages();

    // determine encryption state for display
    if (activeDm) {
      encState = dmChannels.has(activeDm) ? 'e2ee' : 'plain';
    } else {
      encState = roomKey ? 'room-key' : 'plain';
    }

    const relayStatus = connected ? `<span style="color:${C.green}">ok</span>` : `<span style="color:${C.red}">--</span>`;

    if (activeDm) {
      const peerLabel = pubkeyToNick.get(activeDm) || shortPub(activeDm);
      topbar.innerHTML = `<b style="color:${C.dm}">[e2ee] ${esc(peerLabel)}</b><span style="color:${C.border}">|</span><span style="color:${C.muted}">encrypted DM | /close to end</span><span style="margin-left:auto;color:${C.muted}">relay: ${relayStatus}</span>`;
    } else {
      topbar.innerHTML = `<b style="color:${C.bright}">#${esc(room)}</b><span style="color:${C.border}">|</span><span style="color:${C.muted}">shielded lobby | /help</span><span style="margin-left:auto;color:${C.muted}">relay: ${relayStatus}</span>`;
    }

    msgArea.innerHTML = msgs.map(m => {
      if (m.system) return `<div style="line-height:1.4"><span style="color:${C.muted}">${m.time}</span><span style="color:${C.gold}"> -!- </span><span style="color:${C.muted}">${esc(m.text)}</span></div>`;
      const col = m.color || C.gold;
      const dmTag = m.dm ? `<span style="color:${C.dm}">[e2ee] </span>` : '';
      return `<div style="line-height:1.4"><span style="color:${C.muted}">${m.time}</span>${dmTag}<span style="color:${C.border}"> &lt;</span><b style="color:${col}">${esc(m.nick)}</b><span style="color:${C.border}">&gt; </span>${esc(m.text)}</div>`;
    }).join('');
    msgArea.scrollTop = msgArea.scrollHeight;

    const tag = loggedIn ? `<span style="color:${C.green}">zid</span>` : `<span style="color:${C.muted}">anon</span>`;
    const encTag = encState === 'e2ee'
      ? `<span style="color:${C.dm}">[e2ee]</span>`
      : encState === 'room-key'
      ? `<span style="color:${C.amber}">[room-key]</span>`
      : `<span style="color:${C.muted}">[plain]</span>`;
    const viewLabel = activeDm
      ? `<span style="color:${C.dm}">${esc(pubkeyToNick.get(activeDm) || shortPub(activeDm))}</span>`
      : `<span style="color:${C.amber}">#${esc(room)}</span>`;
    statusEl.innerHTML = `<span>[${viewLabel}]</span><span>[<span style="color:${C.gold}">${esc(nick)}</span>]</span><span>[${tag}]</span><span>${encTag}</span><span style="margin-left:auto">zitadel &#x2B21; zafu</span>`;

    bar.innerHTML = `<span style="color:${C.border}">[</span><b style="color:${C.gold}">${esc(nick)}</b><span style="color:${C.border}">]</span>`;
    bar.appendChild(inp);
    inp.focus();
    renderSidebar();
  }

  // WebSocket
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function connectRelay() {
    addMsg('zitadel', `connecting to relay...`, true);
    try {
      ws = new WebSocket(RELAY_WS);
    } catch (e) {
      addMsg('zitadel', `ws error: ${e}`, true);
      return;
    }

    ws.onopen = () => {
      connected = true;
      addMsg('zitadel', 'connected to relay', true);
      // announce ZID pubkey to relay so others can look us up
      if (zidPubkey) {
        wsSend({ t: 'announce', pubkey: zidPubkey });
      }
      // auto-join initial room (create if doesn't exist)
      wsSend({ t: 'join', room: initialRoom, nick });
      // keepalive ping every 30s. some intermediaries (Cloudflare,
      // residential ISPs, the relay itself) close idle WebSockets after
      // ~60s. without a heartbeat the connection drops every time the
      // user goes idle, forcing reconnect + history replay.
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'ping' }));
        }
      }, 30000);
    };

    let joinRetried = false;

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        switch (msg.t) {
          case 'msg': {
            if (msg.nick === nick) break;
            // track nick -> pubkey mapping if available
            if (msg.pubkey && msg.nick) {
              nickToPubkey.set(msg.nick, msg.pubkey);
              pubkeyToNick.set(msg.pubkey, msg.nick);
            }
            // try to decrypt room-encrypted message; suppress entirely if
            // we can't decrypt rather than spilling raw envelopes into chat.
            // typical reason for failure: server is replaying old messages
            // from before the room key derivation was finalized for the
            // current client version.
            let text: string | null = msg.text;
            if (msg.enc) {
              text = null; // default to suppressed unless we successfully decrypt
              if (!roomKey) {
                console.debug('[zitadel] enc=true but no roomKey yet, suppressing',
                  `(room=${msg.room ?? '?'}, currentRoom=${currentRoom ?? '?'})`);
              } else {
                try {
                  const envelope = JSON.parse(msg.text);
                  if (envelope.ct && envelope.iv) {
                    const decrypted = await decryptRoomMsg(roomKey, envelope.ct, envelope.iv);
                    if (decrypted !== null) {
                      text = decrypted;
                    } else {
                      console.debug('[zitadel] room-key decrypt returned null, suppressing',
                        `(room=${msg.room ?? currentRoom ?? '?'})`);
                    }
                  } else {
                    console.debug('[zitadel] enc=true but envelope missing ct/iv, suppressing:',
                      Object.keys(envelope));
                  }
                } catch (e) {
                  console.debug('[zitadel] enc=true but msg.text is not JSON envelope, suppressing:',
                    (e as Error).message, msg.text?.slice(0, 60));
                }
              }
            }
            // skip rendering when we couldn't decrypt - silent drop instead
            // of pasting raw ciphertext into the chat scrollback
            if (text === null) break;
            addMsg(msg.nick, text, false, msg.room || currentRoom || undefined);
            break;
          }
          case 'joined':
            currentRoom = msg.room;
            joinedRooms.add(msg.room);
            joinRetried = false;
            addMsg('zitadel', `joined #${msg.room} (${msg.count} users)`, true);
            // derive room key for encryption
            roomKey = await deriveRoomKey(msg.room);
            if (!activeDm) encState = 'room-key';
            render();
            break;
          case 'created':
            addMsg('zitadel', `room created: ${msg.room}`, true);
            // auto-join the room we just created
            wsSend({ t: 'join', room: msg.room, nick });
            break;
          case 'left':
            addMsg('zitadel', `${msg.nick} left (${msg.count} users)`, true);
            break;
          case 'users':
            // relay sends user list with pubkeys on join
            if (Array.isArray(msg.users)) {
              for (const u of msg.users) {
                if (u.nick && u.pubkey) {
                  nickToPubkey.set(u.nick, u.pubkey);
                  pubkeyToNick.set(u.pubkey, u.nick);
                }
              }
            }
            break;
          case 'system':
            addMsg('zitadel', msg.text, true);
            break;
          case 'error':
            // if lobby doesn't exist, create it (persistent, TTL=0)
            if (msg.msg === 'room not found or expired' && !joinRetried) {
              joinRetried = true;
              addMsg('zitadel', 'room not found, creating...', true);
              wsSend({ t: 'create', nick, room: initialRoom });
            } else {
              addMsg('zitadel', `error: ${msg.msg}`, true);
            }
            break;
        }
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      connected = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      addMsg('zitadel', 'disconnected from relay', true);
      render();
      // reconnect after 3s
      setTimeout(connectRelay, 3000);
    };

    ws.onerror = () => {
      addMsg('zitadel', 'relay connection error', true);
    };
  }

  function wsSend(obj: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // command hints
  const CMDS: Record<string, string> = {
    '/nick':     '/nick <name>        change your nickname',
    '/j':        '/j <room>           join or create a channel',
    '/part':     '/part               leave current channel',
    '/poker':    '/poker [code]       create or join poker table',
    '/msg':      '/msg <target> <text>  DM (nick or pubkey)',
    '/dm':       '/dm <pubkey> <text>   DM by explicit pubkey',
    '/channels': '/channels           list open DM channels',
    '/close':    '/close [pubkey]     close a DM channel',
    '/whois':    '/whois              show ZID identity + status',
    '/clear':    '/clear              clear messages',
    '/connect':  '/connect            reconnect to relay',
    '/help':     '/help               show all commands',
  };

  const hint = mkEl('div', `position:absolute;bottom:100%;left:0;right:0;background:${C.panel};border:1px solid ${C.border};padding:4px 12px;font-size:12px;display:none;max-height:200px;overflow-y:auto;`);
  bar.style.position = 'relative';
  bar.appendChild(hint);

  inp.addEventListener('input', () => {
    const v = inp.value;
    if (v === '/' || v === '?') {
      hint.style.display = 'block';
      hint.innerHTML = Object.values(CMDS).map(c => `<div style="color:${C.muted};line-height:1.6">${esc(c)}</div>`).join('');
    } else if (v.startsWith('/') && v.length > 1) {
      const prefix = v.split(/\s/)[0]?.toLowerCase() ?? '';
      const matches = Object.entries(CMDS).filter(([k]) => k.startsWith(prefix));
      if (matches.length > 0 && matches.length < Object.keys(CMDS).length) {
        hint.style.display = 'block';
        hint.innerHTML = matches.map(([, c]) => `<div style="color:${C.muted};line-height:1.6">${esc(c)}</div>`).join('');
      } else {
        hint.style.display = 'none';
      }
    } else {
      hint.style.display = 'none';
    }
  });

  // input handler
  inp.addEventListener('keydown', (e: KeyboardEvent) => {
    hint.style.display = 'none';
    if (e.key === 'ArrowUp') { if (histIdx < history.length - 1) { histIdx++; inp.value = history[histIdx] ?? ''; } return; }
    if (e.key === 'ArrowDown') { if (histIdx > 0) { histIdx--; inp.value = history[histIdx] ?? ''; } else { histIdx = -1; inp.value = ''; } return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    history.unshift(text);
    histIdx = -1;

    if (text.startsWith('/')) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      switch (cmd?.toLowerCase()) {
        case 'help':
          addMsg('zitadel', '/nick /j /part /poker /msg /dm /channels /close /whois /clear /connect', true);
          addMsg('zitadel', 'DMs use Noise IK e2ee. /msg <nick_or_pubkey> <text> to start.', true);
          break;

        case 'nick':
          if (args[0]) { const old = nick; nick = args[0]; addMsg('zitadel', `${old} is now known as ${nick}`, true); render(); }
          break;

        case 'j': case 'join':
          if (args[0]) { switchRoom(args[0]); }
          else addMsg('zitadel', 'usage: /j <room>', true);
          break;

        case 'part':
          if (activeDm) {
            // switch back to room view
            activeDm = null;
            encState = roomKey ? 'room-key' : 'plain';
            render();
          } else if (currentRoom) {
            wsSend({ t: 'part' });
            joinedRooms.delete(currentRoom);
            addMsg('zitadel', `left #${currentRoom}`, true);
            currentRoom = null;
            roomKey = null;
            encState = 'plain';
            render();
          }
          break;

        case 'poker': {
          const room = args[0] || 'new';
          const pokerUrl = `https://poker.zk.bot/${room}`;
          addMsg('zitadel', `opening poker table${args[0] ? ' ' + args[0] : ''}...`, true);
          window.open(pokerUrl, '_blank');
          break;
        }

        case 'msg': {
          // /msg <nick_or_pubkey> <text>
          if (!args[0] || !args[1]) {
            addMsg('zitadel', 'usage: /msg <nick_or_pubkey> <text>', true);
            break;
          }
          const target = resolveTarget(args[0]);
          if (!target) {
            addMsg('zitadel', `unknown target: ${args[0]}. use a nick or 64-char hex pubkey.`, true);
            break;
          }
          const dmText = args.slice(1).join(' ');
          switchToDm(target);
          void sendDm(target, dmText);
          break;
        }

        case 'dm': {
          // /dm <pubkey> <text> - explicit pubkey form
          if (!args[0] || !args[1]) {
            addMsg('zitadel', 'usage: /dm <pubkey> <text>', true);
            break;
          }
          if (!isHexPubkey(args[0])) {
            addMsg('zitadel', 'pubkey must be 64 hex characters. use /msg for nicks.', true);
            break;
          }
          const dmText = args.slice(1).join(' ');
          switchToDm(args[0]);
          void sendDm(args[0], dmText);
          break;
        }

        case 'channels': {
          const chans = [...dmChannels.keys()];
          if (chans.length === 0) {
            addMsg('zitadel', 'no open DM channels. use /msg or /dm to start one.', true);
          } else {
            addMsg('zitadel', `open DM channels (${chans.length}):`, true);
            for (const pub of chans) {
              const peerNick = pubkeyToNick.get(pub) || 'unknown';
              addMsg('zitadel', `  [e2ee] ${shortPub(pub)} (${peerNick}) - ${pub}`, true);
            }
          }
          break;
        }

        case 'close': {
          // /close [pubkey] - close DM channel, default to active DM
          const closePub = args[0] ? resolveTarget(args[0]) : activeDm;
          if (!closePub) {
            addMsg('zitadel', 'usage: /close [pubkey] - close a DM channel', true);
            break;
          }
          if (!dmChannels.has(closePub)) {
            addMsg('zitadel', `no open channel with ${shortPub(closePub)}`, true);
            break;
          }
          closeDmChannel(closePub);
          break;
        }

        case 'whois': {
          if (zidPubkey) {
            addMsg('zitadel', `--- ZID identity ---`, true);
            addMsg('zitadel', `nick: ${nick}`, true);
            addMsg('zitadel', `zid: ${shortPub(zidPubkey)}`, true);
            addMsg('zitadel', `pubkey: ${zidPubkey}`, true);
            addMsg('zitadel', `room: ${currentRoom || 'none'}`, true);
            addMsg('zitadel', `encryption: ${encState}`, true);
            addMsg('zitadel', `DM channels: ${dmChannels.size}`, true);
            addMsg('zitadel', `Noise capable: ${zidPrivkey ? 'yes' : 'no (wallet locked)'}`, true);
            addMsg('zitadel', `relay: ${connected ? 'ok' : 'disconnected'}`, true);
          } else {
            addMsg('zitadel', `you are ${nick} | ephemeral session | room: ${currentRoom || 'none'} | relay: ${connected ? 'ok' : 'disconnected'}`, true);
            addMsg('zitadel', `connect zafu for ZID identity and e2ee DMs.`, true);
          }
          break;
        }

        case 'connect':
          if (!connected) connectRelay();
          else addMsg('zitadel', 'already connected', true);
          break;

        case 'clear':
          roomMessages().length = 0; render();
          break;

        default:
          addMsg('zitadel', `unknown: /${cmd}`, true);
      }
    } else {
      // if viewing a DM, send as DM
      if (activeDm) {
        void sendDm(activeDm, text);
        return;
      }

      // send to relay (room message)
      if (connected && currentRoom) {
        if (roomKey) {
          // encrypt with room key
          void encryptRoomMsg(roomKey, text).then(({ ct, iv }) => {
            wsSend({ t: 'msg', text: JSON.stringify({ ct, iv }), enc: true });
          });
        } else {
          wsSend({ t: 'msg', text });
        }
        // add locally (relay will broadcast to others, we show ours immediately)
        addMsg(nick, text);
      } else if (!connected) {
        addMsg('zitadel', 'not connected. type /connect', true);
      } else {
        addMsg('zitadel', 'not in a channel. type /j <room>', true);
      }
    }
  });

  // init
  resolveZidIdentity().then(async (zid) => {
    loggedIn = zid.loggedIn;
    zidPubkey = zid.pubkey;
    zidPrivkey = zid.privkey;

    if (zid.pubkey) {
      nick = shortPub(zid.pubkey);
    } else {
      nick = 'anon' + String((Math.random() * 100000) | 0).padStart(5, '0');
    }

    if (zid.loggedIn) {
      addMsg('zitadel', `logged in via zafu - zid: ${zid.pubkey ? shortPub(zid.pubkey) : 'unknown'}`, true);
      if (zid.privkey) {
        addMsg('zitadel', 'Noise IK e2ee available for DMs.', true);
      } else {
        addMsg('zitadel', 'wallet locked - DMs unavailable. unlock zafu for e2ee.', true);
      }
    } else {
      addMsg('zitadel', 'ephemeral session. connect zafu for ZID identity and e2ee DMs.', true);
    }
    addMsg('zitadel', 'welcome to zitadel. type /help for commands.', true);
    render();
    // auto-connect to relay and join initial room
    connectRelay();
  });
}

boot();
