// zitadel: irc-style public channels + e2ee DMs, served locally from
// the zafu extension. plain DOM, zero framework deps.
//
// rooms are PUBLIC — messages are cleartext to the relay and to anyone
// it forwards them to. nick claims are signed under zid-auth-v1
// (ed25519 over canonical bytes); peers verify per-claim. there is no
// room-level encryption.
//
// DMs use Noise IK over a separate WebSocket. they are end-to-end
// encrypted between two ZID keypairs.

import { ed25519 } from '@noble/curves/ed25519'
import { createNoiseChannel, type ZidChannel } from '../../../../packages/zid/src'
import type { SessionKey } from '../../../../packages/zid/src/noise-channel'
import { isLicenseValid, type License } from '../../../../packages/wallet/src/license'

// ─── zid-auth-v1: signed nick claims ────────────────────────────────────
//
// each client signs an `announce` payload binding (server, nick, pubkey, ts).
// receivers verify before trusting the nick → pubkey mapping. relay
// stays dumb (no signature verification on the server side); identity
// is verified peer-to-peer using ZID ed25519 keys.
//
// signed payload (canonical bytes):
//   "zafu-zid-auth-v1" 0x00 server 0x00 nick 0x00 pubkey_hex 0x00 ts_str
//
// receiver checks (in order):
//   1. v === 'zid-auth-v1'
//   2. |now - ts| <= 60_000 ms          (freshness, no replay over time)
//   3. server === expected server URL    (no replay across servers)
//   4. ed25519.verify(pubkey, payload, sig)
//   5. first claim wins for a given nick (reject re-binding)

const ZID_AUTH_VERSION = 'zid-auth-v1';
const ZID_AUTH_DOMAIN = 'zafu-zid-auth-v1';
const ZID_AUTH_FRESHNESS_MS = 60_000;

/** Server identity used in zid-auth-v1 signed payloads. Derived from the
 * active relay's WebSocket URL host so users can switch relays and
 * still sign/verify announces consistently with their peers on the
 * same relay. */
function relayHost(wsUrl: string): string {
  try { return new URL(wsUrl).host; } catch { return wsUrl; }
}

function zidAuthPayload(server: string, nick: string, pubkey: string, ts: number): Uint8Array {
  return new TextEncoder().encode(
    [ZID_AUTH_DOMAIN, server, nick, pubkey, String(ts)].join('\0'),
  );
}

interface AnnounceProof {
  v: string;
  server: string;
  pubkey: string;
  nick: string;
  ts: number;
  sig: string;
}

function signAnnounce(priv: Uint8Array, pubkey: string, nick: string, server: string): AnnounceProof {
  const ts = Date.now();
  const payload = zidAuthPayload(server, nick, pubkey, ts);
  const sig = ed25519.sign(payload, priv);
  return {
    v: ZID_AUTH_VERSION,
    server,
    pubkey,
    nick,
    ts,
    sig: hex(sig),
  };
}

// ─── zid-msg-v1: signed chat messages ───────────────────────────────────
//
// Each chat line, when the sender's wallet is unlocked, is wrapped in
// a JSON envelope that carries an ed25519 signature over the message
// content. Receivers verify the envelope and use it as both message
// integrity proof AND an implicit announce - if no nick→pubkey
// binding exists for the sender, the verified envelope establishes
// one (subject to first-claim-wins).
//
// This closes the gap left by the announce-on-join model: a peer who
// never explicitly announced could still send messages tagged with
// any nick. Per-message proofs make every line carry its own
// authentication.
//
// Wire format (carried in the relay's `text` field):
//   {
//     v: 'zid-msg-v1',
//     text: '<plaintext message>',
//     pubkey: '<hex 64>',
//     nick: '<utf8>',
//     room: '<channel>',
//     ts: <unix ms>,
//     sig: '<hex 128>'
//   }
//
// Signed payload (canonical bytes):
//   "zafu-zid-msg-v1" 0x00 server 0x00 room 0x00 nick 0x00 pubkey 0x00 ts 0x00 text

const ZID_MSG_VERSION = 'zid-msg-v1';
const ZID_MSG_DOMAIN = 'zafu-zid-msg-v1';
const ZID_MSG_FRESHNESS_MS = 60_000;

interface MsgProof {
  v: string;
  text: string;
  pubkey: string;
  nick: string;
  room: string;
  ts: number;
  sig: string;
}

function zidMsgPayload(server: string, room: string, nick: string, pubkey: string, ts: number, text: string): Uint8Array {
  return new TextEncoder().encode(
    [ZID_MSG_DOMAIN, server, room, nick, pubkey, String(ts), text].join('\0'),
  );
}

function signMsg(priv: Uint8Array, pubkey: string, nick: string, room: string, server: string, text: string): MsgProof {
  const ts = Date.now();
  const payload = zidMsgPayload(server, room, nick, pubkey, ts, text);
  const sig = ed25519.sign(payload, priv);
  return { v: ZID_MSG_VERSION, text, pubkey, nick, room, ts, sig: hex(sig) };
}

function verifyMsg(a: unknown, expectedServer: string): MsgProof | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  if (o['v'] !== ZID_MSG_VERSION) return null;
  if (typeof o['text'] !== 'string') return null;
  if (typeof o['pubkey'] !== 'string' || !isHexPubkey(o['pubkey'])) return null;
  if (typeof o['nick'] !== 'string' || !o['nick']) return null;
  if (typeof o['room'] !== 'string') return null;
  if (typeof o['ts'] !== 'number' || !Number.isFinite(o['ts'])) return null;
  if (typeof o['sig'] !== 'string' || !/^[0-9a-f]{128}$/i.test(o['sig'])) return null;
  if (Math.abs(Date.now() - o['ts']) > ZID_MSG_FRESHNESS_MS) return null;
  try {
    const payload = zidMsgPayload(expectedServer, o['room'], o['nick'], o['pubkey'], o['ts'], o['text']);
    if (!ed25519.verify(unhex(o['sig']), payload, unhex(o['pubkey']))) return null;
  } catch { return null; }
  // Normalize to lowercase before returning so downstream key
  // comparisons (nickToPubkey, ignoredPubkeys lookup) don't have to
  // care about the sender's hex case.
  const proof = o as unknown as MsgProof;
  proof.pubkey = proof.pubkey.toLowerCase();
  return proof;
}

function verifyAnnounce(a: unknown, expectedServer: string): AnnounceProof | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  if (o['v'] !== ZID_AUTH_VERSION) return null;
  if (typeof o['server'] !== 'string' || o['server'] !== expectedServer) return null;
  if (typeof o['pubkey'] !== 'string' || !isHexPubkey(o['pubkey'])) return null;
  if (typeof o['nick'] !== 'string' || !o['nick']) return null;
  if (typeof o['ts'] !== 'number' || !Number.isFinite(o['ts'])) return null;
  if (typeof o['sig'] !== 'string' || !/^[0-9a-f]{128}$/i.test(o['sig'])) return null;
  if (Math.abs(Date.now() - o['ts']) > ZID_AUTH_FRESHNESS_MS) return null;
  try {
    const payload = zidAuthPayload(o['server'], o['nick'], o['pubkey'], o['ts']);
    if (!ed25519.verify(unhex(o['sig']), payload, unhex(o['pubkey']))) return null;
  } catch {
    return null;
  }
  // Normalize the pubkey to lowercase so all downstream key
  // comparisons use one canonical form regardless of sender hex case.
  const proof = o as unknown as AnnounceProof;
  proof.pubkey = proof.pubkey.toLowerCase();
  return proof;
}

/** Read the persisted license blob from chrome.storage.local and check
 * that it's currently valid. Channel creation is gated on Pro because
 * channels are persistent state on the relay; free users can join any
 * existing channel but cannot mint new ones. */
async function isProUser(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get('proLicense');
    const raw = r['proLicense'];
    if (typeof raw !== 'string' || !raw) return false;
    const license: License = JSON.parse(raw);
    return isLicenseValid(license);
  } catch {
    return false;
  }
}

/** Default relay. Users can switch via `/server <url>` (persisted in
 * chrome.storage.local under RELAY_URL_KEY). The DM transport is
 * derived by appending `/zid` to the chat URL's path - relays that
 * implement zitadel are expected to expose both at adjacent paths. */
export const DEFAULT_RELAY_WS = "wss://relay.zk.bot/ws";
const RELAY_URL_KEY = 'zitadelRelayUrl';
/** Per-ZID persisted nickname. Stored under `zidNick:<pubkey>` in
 * chrome.storage.local so the same identity gets the same nick across
 * sessions. Survives extension restart but not vault wipe / mnemonic
 * restore - that would require putting it in the vault insensitive
 * blob, which is a larger change. */
const ZID_NICK_PREFIX = 'zidNick:';

/** Reject nicks that would break the wire protocol or look like junk.
 * Forbidden: empty, length > 32, whitespace, NUL (used as field
 * separator in zid-msg-v1 canonical payload and DM packing). */
function isValidNick(s: string): boolean {
  return s.length > 0 && s.length <= 32 && !/[\s\0]/.test(s);
}

/** Storage key for the user's pubkey-based ignore list. Stored as a
 * JSON array of lowercase hex pubkeys so the set survives reload. */
const ZID_IGNORE_KEY = 'zidIgnore';

/** Storage key for the desktop-notification opt-in. We never request
 * Notification permission on page load - the user opts in via /notify,
 * which both flips this flag and (if needed) triggers the browser's
 * permission prompt. Stored as the literal string "1" or absent. */
const ZID_NOTIFY_KEY = 'zidNotify';

/** Returns true if the URL parses as wss:// or ws:// */
function isValidRelayUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'wss:' || u.protocol === 'ws:';
  } catch { return false; }
}

/** Derive the DM (zid) WebSocket URL from the chat URL by appending
 * `/zid` to its path. e.g. wss://relay.example/ws → wss://relay.example/ws/zid */
function deriveZidWsUrl(chatUrl: string): string {
  try {
    const u = new URL(chatUrl);
    u.pathname = (u.pathname.replace(/\/+$/, '')) + '/zid';
    return u.toString();
  } catch { return chatUrl + '/zid'; }
}

/** Back-compat re-export so other code paths that still import RELAY_WS
 * see the default value. The runtime uses the mutable relayUrl in
 * boot() instead. */
export const RELAY_WS = DEFAULT_RELAY_WS;

const C = {
  bg: "#0F0F1A", panel: "#16162A", border: "#2A2A4A",
  gold: "#F4B728", amber: "#D4991A", muted: "#6B6B8D",
  text: "#C8C8E0", bright: "#E8E8FF", green: "#4ADE80", red: "#F87171",
  cyan: "#22D3EE", purple: "#A78BFA", dm: "#FF79C6",
};

interface Msg {
  nick: string; text: string; time: string;
  /** absolute receive time in ms; used for the tooltip date and the
   * day-divider in scrollback. distinct from `time` (HH:MM) so we
   * don't reformat strings to find the date. */
  tsMs: number;
  system?: boolean; color?: string; dm?: boolean; action?: boolean;
  /** This specific message was cryptographically verified - either
   * via a zid-msg-v1 envelope that passed verification, or because
   * it arrived over an authenticated DM channel. The verified `+`
   * mark on render is gated on this, NOT on per-nick session state,
   * so a nick-spoofed unsigned message never inherits a verified
   * mark from an earlier signed announce by the real holder. */
  verified?: boolean;
}

/** CTCP ACTION marker - same wire format IRC has used since 1994. The
 * marker travels inside the signed text, so an attacker cannot strip
 * the action-ness without invalidating the zid-msg-v1 signature, and
 * cannot graft the marker onto a non-action message. */
const ACTION_PREFIX = '\x01ACTION ';
const ACTION_SUFFIX = '\x01';

function isActionText(s: string): boolean {
  return s.startsWith(ACTION_PREFIX) && s.endsWith(ACTION_SUFFIX);
}
function stripAction(s: string): string {
  return s.slice(ACTION_PREFIX.length, s.length - ACTION_SUFFIX.length);
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

// -- encryption state label --
//
// rooms are public (cleartext to the relay). DMs are e2ee via Noise IK.
// no third "room-key" state - it lied about security.

type EncState = 'e2ee' | 'public';

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Render text with http/https URLs as clickable links. Restricted to
 * http(s) so a malicious peer can't sneak in javascript:, data:, or
 * file: schemes. Anchor uses noopener+noreferrer so the destination
 * can't grab window.opener and the referrer doesn't leak the chat
 * page URL. The href and visible text are both escaped - we never
 * concatenate raw URL into HTML. Trailing sentence punctuation that
 * the regex grabbed greedily is stripped off the URL and rendered as
 * plain text, so "see https://x.com." links to https://x.com and the
 * period stays visible after the link. Newlines render as <br>. */
const URL_TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;
function linkify(text: string, linkColor: string): string {
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  let result = '';
  let lastIdx = 0;
  for (const m of text.matchAll(urlRe)) {
    const idx = m.index!;
    const raw = m[1]!;
    const trailMatch = raw.match(URL_TRAILING_PUNCT);
    const trailing = trailMatch ? trailMatch[0] : '';
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    result += esc(text.slice(lastIdx, idx));
    const eu = esc(url);
    result += `<a href="${eu}" target="_blank" rel="noopener noreferrer" style="color:${linkColor};text-decoration:underline">${eu}</a>`;
    if (trailing) result += esc(trailing);
    lastIdx = idx + raw.length;
  }
  result += esc(text.slice(lastIdx));
  // newlines: HTML collapses \n to whitespace inside a div, so a
  // multi-line message would render as one line. wire-format scripts
  // (poker bots, FROST tooling) can emit \n; render them honestly.
  return result.replace(/\n/g, '<br>');
}
function now() { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
/** YYYY-MM-DD in local time. used to detect date-boundary crossings
 * for the irssi-style day separator. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Human-readable absolute timestamp for the time-tooltip (e.g.
 * "Wed 2026-05-01 14:32:14 local"). */
function fullTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${localDateKey(d)} ${h}:${m}:${s}`;
}

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
  let encState: EncState = 'public';
  const messagesPerRoom = new Map<string, Msg[]>();
  const joinedRooms = new Set<string>();
  const DEFAULT_CHANNELS = ['zitadel', 'support', 'dev'];
  const history: string[] = [];
  let histIdx = -1;

  // active relay URL (for chat WebSocket). DM (zid) URL is derived.
  // both can be retargeted at runtime via /server <url>.
  let relayUrl: string = DEFAULT_RELAY_WS;

  // append-only render bookkeeping. msgArea is updated in two modes:
  //   1. view switched (or first render): clear and render every message
  //      in the new view's buffer.
  //   2. same view: append the new messages since the last render.
  // motivated by irssi-style smoothness - rebuilding 500-line scrollback
  // on every new message is the dominant frontend stutter source.
  let renderedView: string | null = null;
  const renderedCount = new Map<string, number>();
  // index of the first unread message at the moment the user switched
  // *into* a view. drawn as an irssi-style "── N new ──" divider on
  // the next full rebuild of that view, then cleared so it doesn't
  // reappear after the user has actually read past it.
  const firstNewIdx = new Map<string, number>();
  // unread + mention state per non-active view. cleared when the user
  // switches into the view. used to decorate the channel/DM row in the
  // sidebar.
  const unreadCount = new Map<string, number>();
  const mentioned = new Set<string>();
  // tab-completion cycle state. null when no completion is in progress.
  let tabState: { prefix: string; before: string; after: string; matches: string[]; idx: number } | null = null;
  // DM channels: pubkey -> ZidChannel
  const dmChannels = new Map<string, ZidChannel>();
  // nick -> pubkey mapping from relay user list
  const nickToPubkey = new Map<string, string>();
  // pubkey -> nick (reverse)
  const pubkeyToNick = new Map<string, string>();
  // nicks for which we have verified a zid-auth-v1 announce. these are
  // rendered with a green `+` sigil (IRC voice-mode convention) so the
  // user can tell at a glance which peers proved possession of their
  // ZID. the user's own nick is added on first signed announce we send.
  const verifiedNicks = new Set<string>();
  // pubkeys the user has chosen to silence. keyed on pubkey not nick
  // because nicks are mutable and collidable - only the pubkey is
  // unforgeable. messages and announces from these pubkeys are dropped
  // before render. persisted in chrome.storage.local under "zidIgnore".
  const ignoredPubkeys = new Set<string>();
  // dedupe collision warnings: once we've told the user that pubkey X
  // tried to claim nick alice, don't warn again for the same pair.
  // without this, a persistent attacker could spam the chat with
  // security messages instead of actual impersonation - silent failure
  // would be worse, but loud failure has its own DoS shape.
  const collisionWarned = new Set<string>();
  // desktop notifications opt-in flag. on /notify, set true and ensure
  // permission. fires only when the page is hidden so an active reader
  // isn't double-pinged by both the in-page render and a system popup.
  let notifyEnabled = false;
  function warnCollision(claimedNick: string, attemptedPubkey: string, source: 'announce' | 'msg') {
    const key = `${claimedNick}\0${attemptedPubkey}`;
    if (collisionWarned.has(key)) return;
    collisionWarned.add(key);
    const existing = nickToPubkey.get(claimedNick);
    addMsg('zitadel',
      `!! nick collision on ${claimedNick}: ${shortPub(attemptedPubkey)} tried to claim it via ${source}, but it's bound to ${existing ? shortPub(existing) : '?'}. attempt dropped. /ignore ${attemptedPubkey} to silence.`,
      true);
  }
  /** Bind a (nick, pubkey) pair after a successful verification.
   * Cleans up stale forward entries when the same pubkey re-announces
   * under a new nick (a /nick rename): without that cleanup,
   * nickToPubkey accumulates the entire history of every peer's old
   * names, so /share oldnick still resolves to the same pubkey and
   * verifiedNicks grows unbounded across renames. */
  function rebindIdentity(newNick: string, pubkey: string) {
    const oldNick = pubkeyToNick.get(pubkey);
    if (oldNick && oldNick !== newNick) {
      nickToPubkey.delete(oldNick);
      verifiedNicks.delete(oldNick);
    }
    nickToPubkey.set(newNick, pubkey);
    pubkeyToNick.set(pubkey, newNick);
    verifiedNicks.add(newNick);
  }
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
  const main = mkEl('div', `flex:1;display:flex;flex-direction:column;min-width:0;position:relative;`);
  const topbar = mkEl('div', `background:${C.panel};border-bottom:1px solid ${C.border};padding:6px 12px;display:flex;align-items:center;gap:8px;`);
  const msgArea = mkEl('div', `flex:1;overflow-y:auto;padding:8px 12px;`);
  const statusEl = mkEl('div', `background:${C.panel};border-top:1px solid ${C.border};padding:4px 12px;font-size:11px;color:${C.muted};display:flex;gap:16px;`);
  const bar = mkEl('div', `background:${C.bg};border-top:1px solid ${C.border};padding:8px 12px;display:flex;align-items:center;gap:8px;`);
  // floating "↓ N new" pill - hidden by default, surfaced when the user
  // is scrolled up and new messages have arrived. position is anchored
  // to the relatively-positioned `main` above the status bar.
  const scrollPill = mkEl('div', `position:absolute;right:16px;bottom:64px;background:${C.gold};color:${C.bg};padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;cursor:pointer;display:none;box-shadow:0 2px 6px rgba(0,0,0,0.4);z-index:10;`);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.autofocus = true;
  inp.placeholder = 'type a message... (/ for commands)';
  inp.style.cssText = `flex:1;background:transparent;border:none;outline:none;color:${C.bright};font-family:inherit;font-size:inherit;caret-color:${C.gold};`;
  bar.appendChild(inp);
  main.append(topbar, msgArea, statusEl, bar, scrollPill);
  root.append(sidebar, main);

  // unseen-while-scrolled bookkeeping. only the currently viewed view
  // has a pill; switching views resets it (the new view's history is
  // already visible from the top of the rebuild).
  let unseenScrolled = 0;
  function showPill() {
    if (unseenScrolled <= 0) { scrollPill.style.display = 'none'; return; }
    scrollPill.textContent = `↓ ${unseenScrolled} new`;
    scrollPill.style.display = 'block';
  }
  function resetPill() {
    unseenScrolled = 0;
    scrollPill.style.display = 'none';
  }
  scrollPill.addEventListener('click', () => {
    msgArea.scrollTop = msgArea.scrollHeight;
    resetPill();
  });
  msgArea.addEventListener('scroll', () => {
    const NEAR_BOTTOM_PX = 80;
    const atBottom =
      msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom) resetPill();
  });

  // global Alt+1..9 / Alt+0 jumps to the Nth view in the sidebar
  // (channels first, then DMs in display order). irssi convention
  // for fast keyboard navigation. preventDefault stops Chrome's
  // built-in Alt+number tab-switch on extension pages.
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!/^[0-9]$/.test(e.key)) return;
    e.preventDefault();
    const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
    const channels = [...new Set([...DEFAULT_CHANNELS, ...joinedRooms])];
    const dmPeers = [...dmChannels.keys()];
    if (idx < channels.length) {
      switchRoom(channels[idx]!);
    } else {
      const dmIdx = idx - channels.length;
      if (dmIdx < dmPeers.length) switchToDm(dmPeers[dmIdx]!);
    }
  });

  // delegated click on peer nicks in the message stream: opens a DM
  // view. avoids re-binding handlers on every render churn. the same
  // approach IRC GUIs use to make scrollback feel alive.
  msgArea.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t || !t.classList.contains('nick-click')) return;
    const peerNick = t.dataset['nick'];
    if (!peerNick) return;
    const pub = nickToPubkey.get(peerNick);
    if (!pub) {
      addMsg('zitadel', `no pubkey for ${peerNick} yet - they haven't announced under zid-auth-v1.`, true);
      return;
    }
    switchToDm(pub);
  });

  function mkEl(tag: string, css: string) { const e = document.createElement(tag); e.style.cssText = css; return e; }

  /** Current view key (room name or `dm:<pubkey>`). */
  function currentViewKey(): string {
    return activeDm ? (DM_PREFIX + activeDm) : (currentRoom || initialRoom);
  }

  /** Word-boundary, case-insensitive own-nick match. Skips matches
   * that are part of a longer identifier so "alicia" doesn't trigger
   * highlight for a user nicked "alic". */
  function mentionsMe(text: string, fromNick: string): boolean {
    if (!nick || nick === '...' || fromNick === nick) return false;
    const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`, 'i');
    return re.test(text);
  }

  /** Fire a desktop notification for a directed message (DM or
   * mention) when the page is hidden. Skips if the user hasn't opted
   * in, if permission isn't granted, or if the page is currently
   * focused (the in-page nick highlight is already enough). Click on
   * the notification focuses the chat tab. */
  function maybeNotify(viewKey: string, fromNick: string, text: string, dm: boolean) {
    if (!notifyEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    if (!dm && !mentionsMe(text, fromNick)) return;
    const title = dm ? `DM from ${fromNick}` : `${fromNick} mentioned you`;
    const body = text.length > 140 ? text.slice(0, 137) + '...' : text;
    try {
      const n = new Notification(title, { body, tag: viewKey });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* notification API may be restricted in some contexts */ }
  }

  /** Bookkeeping for unread + mention markers. Increments only when the
   * message is for a view the user isn't currently looking at, isn't
   * from the user themselves, and isn't a system line. DMs always count
   * (they're inherently directed). */
  function trackUnread(viewKey: string, fromNick: string, text: string, system: boolean, dm: boolean) {
    if (system || fromNick === nick) return;
    if (viewKey === currentViewKey()) return;
    unreadCount.set(viewKey, (unreadCount.get(viewKey) ?? 0) + 1);
    if (dm || mentionsMe(text, fromNick)) mentioned.add(viewKey);
    maybeNotify(viewKey, fromNick, text, dm);
  }

  function addMsg(n: string, text: string, system = false, room?: string, dm = false, action = false, verified = false) {
    const key = room || (activeDm ? (DM_PREFIX + activeDm) : (currentRoom || initialRoom));
    let arr = messagesPerRoom.get(key);
    if (!arr) { arr = []; messagesPerRoom.set(key, arr); }
    arr.push({ nick: n, text, time: now(), tsMs: Date.now(), system, color: system ? undefined : nickColor(n), dm, action, verified });
    trackUnread(key, n, text, system, dm);
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
      tsMs: Date.now(),
      dm: true,
      // DM transport authenticates the peer (Noise IK), so receive-side
      // DMs are inherently verified. Outgoing self-messages are
      // trivially verified - we wrote them.
      verified: true,
      color: outgoing ? C.gold : C.dm,
    });
    if (!outgoing) trackUnread(key, fromNick, text, false, true);
    render();
  }

  /** Clear unread + mention state for a view we just switched into. */
  function markRead(viewKey: string) {
    unreadCount.delete(viewKey);
    mentioned.delete(viewKey);
  }

  /** Mark the divider position for an unread view we're about to enter.
   * Capture once *before* markRead so the next full rebuild can draw a
   * divider above the first message that arrived while the user was
   * away. Skipped when there's no unread - no divider to show. */
  function captureDivider(viewKey: string) {
    const unread = unreadCount.get(viewKey) ?? 0;
    if (unread <= 0) return;
    const arr = messagesPerRoom.get(viewKey);
    const len = arr?.length ?? 0;
    const idx = Math.max(0, len - unread);
    firstNewIdx.set(viewKey, idx);
  }

  function switchRoom(room: string) {
    activeDm = null;
    captureDivider(room);
    markRead(room);
    if (room === currentRoom) { render(); return; }
    if (currentRoom) wsSend({ t: 'part' });
    wsSend({ t: 'join', room, nick });
  }

  function switchToDm(pubkey: string) {
    // refuse to open a DM view targeted at self - the resulting Noise
    // IK channel would loop back through the relay to ourselves and
    // produce echo-only behavior. defense in depth; the slash
    // commands also reject earlier with a friendlier message.
    if (zidPubkey && pubkey.toLowerCase() === zidPubkey.toLowerCase()) return;
    activeDm = pubkey;
    captureDivider(DM_PREFIX + pubkey);
    markRead(DM_PREFIX + pubkey);
    encState = dmChannels.has(pubkey) ? 'e2ee' : 'public';
    render();
  }

  /** Leave the currently-viewed room or switch back from a DM. Shared
   * by the /part and /leave commands and the sidebar × affordance.
   * Default channels rejoin on the next sidebar render via the merge
   * with DEFAULT_CHANNELS - matches mIRC's "always-rejoin defaults". */
  function partActiveView() {
    if (activeDm) {
      activeDm = null;
      encState = 'public';
      render();
    } else if (currentRoom) {
      wsSend({ t: 'part' });
      joinedRooms.delete(currentRoom);
      addMsg('zitadel', `left #${currentRoom}`, true);
      currentRoom = null;
      encState = 'public';
      render();
    }
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
      const ch = await createNoiseChannel(session, peerPubkey, deriveZidWsUrl(relayUrl));

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
    if (!ch) return;
    ch.close();
    dmChannels.delete(peerPubkey);
    // wipe all view state for this DM so reopening starts clean -
    // no stale unread badge, no stale "N new" divider, no stale
    // message log. closed should mean closed.
    const key = DM_PREFIX + peerPubkey;
    messagesPerRoom.delete(key);
    unreadCount.delete(key);
    mentioned.delete(key);
    renderedCount.delete(key);
    firstNewIdx.delete(key);
    if (renderedView === key) renderedView = null;
    if (activeDm === peerPubkey) {
      activeDm = null;
      encState = 'public';
    }
    // log the close to the user's current view (room or another DM),
    // not into the just-wiped DM log.
    addMsg('zitadel', `closed DM channel with ${shortPub(peerPubkey)}`, true);
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
        const unread = unreadCount.get(r) ?? 0;
        const isHighlight = mentioned.has(r);
        // priority: active > highlighted > unread > idle
        const col = active ? C.bright : (isHighlight ? C.gold : (unread ? C.text : C.muted));
        const fontWeight = (isHighlight || unread) && !active ? '600' : '400';
        const badge = unread > 0 && !active
          ? ` <span style="color:${isHighlight ? C.gold : C.muted};font-weight:600">(${unread > 99 ? '99+' : unread})</span>`
          : '';
        // close affordance: × shown only on the active channel so we
        // don't clutter idle rows with controls. clicking parts the
        // current view (same path as /part).
        const closeBtn = active
          ? ` <span class="ch-close" title="leave channel" style="color:${C.muted};margin-left:auto;padding:0 4px;cursor:pointer">×</span>`
          : '';
        return `<div class="ch" data-room="${esc(r)}" style="padding:5px 12px;cursor:pointer;background:${bg};color:${col};font-size:13px;font-weight:${fontWeight};transition:background 0.1s;display:flex;align-items:center;gap:4px;">#${esc(r)}${badge}${closeBtn}</div>`;
      }).join('')}
      ${dmPeers.length ? `<div style="padding:10px 12px;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};margin-top:4px;">
        <b style="color:${C.bright};font-size:13px;" title="DM peers - traffic is end-to-end encrypted via Noise IK">DMs [e2ee]</b>
      </div>` : ''}
      ${dmPeers.map(pub => {
        const active = activeDm === pub;
        const bg = active ? C.border : 'transparent';
        const dmKey = DM_PREFIX + pub;
        const unread = unreadCount.get(dmKey) ?? 0;
        // DMs are inherently personal so any unread DM is rendered as
        // a highlight - same color as a mention in a public room.
        const col = active ? C.dm : (unread > 0 ? C.dm : C.muted);
        const fontWeight = unread > 0 && !active ? '600' : '400';
        const label = pubkeyToNick.get(pub) || shortPub(pub);
        const badge = unread > 0 && !active
          ? ` <span style="color:${C.dm};font-weight:600">(${unread > 99 ? '99+' : unread})</span>`
          : '';
        return `<div class="dm-ch" data-pubkey="${esc(pub)}" title="end-to-end encrypted DM" style="padding:5px 12px;cursor:pointer;background:${bg};color:${col};font-size:12px;font-weight:${fontWeight};transition:background 0.1s;">[e2ee] ${esc(label)}${badge}</div>`;
      }).join('')}
      <div class="me-chip" style="padding:8px 12px;margin-top:auto;border-top:1px solid ${C.border};cursor:pointer;transition:background 0.1s;" title="${zidPrivkey ? 'click for /whois (your identity)' : (zidPubkey ? 'click to /login' : 'no zafu identity - install zafu first')}">
        <div style="color:${C.muted};font-size:11px;">${zidPrivkey ? `<span style="color:${C.green}" title="logged in - your messages are signed under zid-msg-v1">+</span>` : ''}${esc(nick)}</div>
        <div style="color:${loggedIn ? C.green : C.muted};font-size:10px;">${zidPubkey ? shortPub(zidPubkey) : 'anon · click to login'}</div>
      </div>
    `;

    sidebar.querySelectorAll('.ch').forEach(el => {
      el.addEventListener('click', (ev) => {
        // × inside the row parts the channel; stopPropagation prevents
        // the parent row from also firing switchRoom.
        const target = ev.target as HTMLElement | null;
        if (target?.classList.contains('ch-close')) {
          ev.stopPropagation();
          partActiveView();
          return;
        }
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

    // identity chip in the footer: click runs /login if locked, or
    // self-/whois if already unlocked. surfaces the most useful action
    // for the current state without making the user remember a verb.
    const meChip = sidebar.querySelector('.me-chip') as HTMLElement | null;
    if (meChip) {
      meChip.addEventListener('click', () => {
        if (zidPubkey && !zidPrivkey) void runLogin();
        else runSelfWhois();
      });
      meChip.addEventListener('mouseenter', () => { meChip.style.background = C.border; });
      meChip.addEventListener('mouseleave', () => { meChip.style.background = 'transparent'; });
    }
  }

  // irssi-style nick column: pad the nick block to a fixed min-width
  // and right-align so the closing `>` (or action `*`) lands at the
  // same column regardless of nick length. Long nicks expand the
  // column for that line only - the eye still finds the message text
  // at a consistent left edge for the common case.
  const NICK_COL_MIN = '12ch';

  /** "── 2026-05-02 ──" centered separator. used both at view rebuild
   * (between consecutive messages whose local date differs) and at
   * append (when a new message crosses midnight from the prior). */
  function dayDividerHTML(dateKey: string): string {
    return `<div style="line-height:1.4;color:${C.muted};text-align:center;padding:4px 0;font-size:11px;letter-spacing:1px">─── ${dateKey} ───</div>`;
  }

  // Render one message into HTML. Pulled out of render() so the same
  // template is used for the full-rebuild path and the append path.
  function renderMsgLineHTML(m: Msg): string {
    // tooltip shows full datetime so a scrollback session that spans
    // hours/days isn't ambiguous about when each line happened.
    const timeAttr = m.tsMs ? ` title="${esc(fullTime(m.tsMs))}"` : '';
    if (m.system) {
      // pad the "-!-" sigil to the same width as the nick column so
      // system lines align with chat lines below them. linkify so
      // /help URLs and other guidance with links are clickable.
      return `<div style="line-height:1.4"><span style="color:${C.muted}"${timeAttr}>${m.time}</span> <span style="display:inline-block;min-width:${NICK_COL_MIN};text-align:right;color:${C.gold}">-!-</span> <span style="color:${C.muted}">${linkify(m.text, C.cyan)}</span></div>`;
    }
    const col = m.color || C.gold;
    const dmTag = m.dm
      ? `<span style="color:${C.dm}" title="end-to-end encrypted via Noise IK">[e2ee] </span>`
      : '';
    // verified peer (zid-auth-v1) gets a green `+` prefix on the
    // nick - same convention IRC uses for voice (+) / op (@). DM
    // messages are inherently authenticated through Noise IK so
    // they always show the marker. The flag is per-message: an
    // unsigned message claiming a previously-verified peer's nick
    // does NOT inherit the mark from session state - that would be
    // a free spoof of the verification UI.
    const verifyMark = m.verified
      ? `<span style="color:${C.green}" title="verified ZID signature - peer proved possession of their identity">+</span>`
      : '';
    // /me actions render as "* nick text" - IRC convention. The
    // signature bound the action-ness, so a verified action carries
    // the same `+` weight as a verified message.
    // wrap peer nicks in a clickable element. one delegated click
    // handler on msgArea (set up in boot) turns the click into a
    // switchToDm. own nick is non-clickable - the sidebar identity
    // chip already covers self-actions.
    const isSelf = m.nick === nick;
    const nickEl = isSelf
      ? `<b style="color:${col}">${esc(m.nick)}</b>`
      : `<b class="nick-click" data-nick="${esc(m.nick)}" style="color:${col};cursor:pointer">${esc(m.nick)}</b>`;
    // mention highlight: irssi paints the whole line with a left border
    // and slight background tint when the user's nick is name-checked
    // so the eye finds it at scrollback speed. DMs aren't highlighted
    // here because every DM is implicitly directed at you.
    const isMention = !isSelf && !m.dm && mentionsMe(m.text, m.nick);
    const lineStyle = isMention
      ? `line-height:1.4;border-left:2px solid ${C.gold};background:rgba(244,183,40,0.07);padding-left:6px;margin-left:-8px;`
      : 'line-height:1.4';
    const bodyHtml = linkify(m.text, C.cyan);
    if (m.action) {
      const nickBlock = `<span style="display:inline-block;min-width:${NICK_COL_MIN};text-align:right"><span style="color:${C.purple}">*</span> ${verifyMark}${nickEl}</span>`;
      return `<div style="${lineStyle}"><span style="color:${C.muted}"${timeAttr}>${m.time}</span> ${dmTag}${nickBlock} <span style="color:${C.text}">${bodyHtml}</span></div>`;
    }
    const nickBlock = `<span style="display:inline-block;min-width:${NICK_COL_MIN};text-align:right"><span style="color:${C.border}">&lt;</span>${verifyMark}${nickEl}<span style="color:${C.border}">&gt;</span></span>`;
    return `<div style="${lineStyle}"><span style="color:${C.muted}"${timeAttr}>${m.time}</span> ${dmTag}${nickBlock} ${bodyHtml}</div>`;
  }

  function render() {
    const room = currentRoom || initialRoom;
    const msgs = roomMessages();

    // determine encryption state for display
    if (activeDm) {
      encState = dmChannels.has(activeDm) ? 'e2ee' : 'public';
    } else {
      encState = 'public';
    }

    const relayStatus = connected ? `<span style="color:${C.green}">ok</span>` : `<span style="color:${C.red}">--</span>`;

    if (activeDm) {
      const peerLabel = pubkeyToNick.get(activeDm) || shortPub(activeDm);
      topbar.innerHTML = `<b style="color:${C.dm}" title="end-to-end encrypted via Noise IK">[e2ee] ${esc(peerLabel)}</b><span style="color:${C.border}">|</span><span style="color:${C.muted}">encrypted DM | /close to end</span><span style="margin-left:auto;color:${C.muted}">relay: ${relayStatus}</span>`;
    } else {
      topbar.innerHTML = `<b style="color:${C.bright}">#${esc(room)}</b><span style="color:${C.border}">|</span><span style="color:${C.muted}">public channel · /help for commands</span><span style="margin-left:auto;color:${C.muted}" title="${esc(relayUrl)}">relay: ${relayStatus} · ${esc(relayHost(relayUrl))}</span>`;
    }

    // current view key (room or DM). used to decide rebuild vs append.
    const viewKey = activeDm ? (DM_PREFIX + activeDm) : (currentRoom || initialRoom);
    // preserve scroll position: only auto-scroll to bottom if the user
    // is already near the bottom. if they've scrolled up to read
    // history, leave them where they are.
    const NEAR_BOTTOM_PX = 80;
    const wasAtBottom =
      msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < NEAR_BOTTOM_PX;

    if (renderedView !== viewKey) {
      // view switched: full rebuild. one-shot innerHTML write so the
      // browser only does one layout pass. interleave day dividers
      // and the irssi-style "new messages" marker (if any).
      const divIdx = firstNewIdx.get(viewKey);
      let html = '';
      let lastDate: string | null = null;
      for (let i = 0; i < msgs.length; i++) {
        if (i === divIdx) {
          const count = msgs.length - i;
          html += `<div style="line-height:1.4;color:${C.amber};text-align:center;padding:2px 0;font-size:11px;letter-spacing:1px">─── ${count} new ───</div>`;
        }
        const m = msgs[i]!;
        if (m.tsMs) {
          const d = localDateKey(new Date(m.tsMs));
          if (lastDate && d !== lastDate) html += dayDividerHTML(d);
          lastDate = d;
        }
        html += renderMsgLineHTML(m);
      }
      msgArea.innerHTML = html;
      firstNewIdx.delete(viewKey);
      renderedView = viewKey;
      renderedCount.set(viewKey, msgs.length);
      msgArea.scrollTop = msgArea.scrollHeight;
      // view switched: the new view is rendered scrolled-to-bottom, so
      // any unseen counter from the previous view is irrelevant.
      resetPill();
    } else {
      // same view: append only the lines added since the last render.
      const already = renderedCount.get(viewKey) ?? msgs.length;
      const added = msgs.length - already;
      if (added > 0) {
        // walk new messages, injecting a day divider on midnight
        // crossings relative to the previously-rendered tail.
        let fragment = '';
        const tailMsg = already > 0 ? msgs[already - 1] : undefined;
        let prevDate = tailMsg?.tsMs ? localDateKey(new Date(tailMsg.tsMs)) : null;
        for (let i = already; i < msgs.length; i++) {
          const m = msgs[i]!;
          if (m.tsMs) {
            const d = localDateKey(new Date(m.tsMs));
            if (prevDate && d !== prevDate) fragment += dayDividerHTML(d);
            prevDate = d;
          }
          fragment += renderMsgLineHTML(m);
        }
        msgArea.insertAdjacentHTML('beforeend', fragment);
        renderedCount.set(viewKey, msgs.length);
      }
      if (wasAtBottom) {
        msgArea.scrollTop = msgArea.scrollHeight;
      } else if (added > 0) {
        // user is reading scrollback; surface a pill so they know
        // new messages have arrived without yanking them down.
        unseenScrolled += added;
        showPill();
      }
    }

    // single chip carries identity + transport status. no separate
    // [zid|anon] and [plain|e2ee] split - they're related and the
    // user only needs to know the resulting condition:
    //
    //   +nick · public    signed-in identity, public room
    //    nick · public    locked wallet, anon-style nick, public room
    //   +peer · e2ee      signed-in identity, e2ee DM with peer
    const myMark = loggedIn ? `<span style="color:${C.green}">+</span>` : '';
    const transport = encState === 'e2ee'
      ? `<span style="color:${C.dm}">e2ee</span>`
      : `<span style="color:${C.muted}">public</span>`;
    const viewLabel = activeDm
      ? `<span style="color:${C.dm}">${esc(pubkeyToNick.get(activeDm) || shortPub(activeDm))}</span>`
      : `<span style="color:${C.amber}">#${esc(room)}</span>`;
    statusEl.innerHTML = `<span>[${viewLabel}]</span><span>${myMark}<span style="color:${C.gold}">${esc(nick)}</span> · ${transport}</span><span style="margin-left:auto">zitadel &#x2B21; zafu</span>`;

    bar.innerHTML = `<span style="color:${C.border}">[</span><b style="color:${C.gold}">${esc(nick)}</b><span style="color:${C.border}">]</span>`;
    bar.appendChild(inp);
    // refocus input - but not if the user has an active text
    // selection somewhere (e.g. they're highlighting message text to
    // copy). without this guard, every incoming message would clobber
    // their selection by stealing focus to the input.
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) inp.focus();
    renderSidebar();
    updateDocumentTitle();
  }

  /** Reflect total unread across all views into document.title so the
   * tab list shows "(3) #foo - zitadel" while the user is on another
   * tab. The currently-viewed view never has unread (markRead clears
   * it on switch), so this captures attention from the views the user
   * is *not* watching - exactly what a tab-list nudge should do. */
  function updateDocumentTitle() {
    let totalUnread = 0;
    for (const n of unreadCount.values()) totalUnread += n;
    const viewName = activeDm
      ? (pubkeyToNick.get(activeDm) || shortPub(activeDm))
      : `#${currentRoom || initialRoom}`;
    document.title = totalUnread > 0
      ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${viewName} - zitadel`
      : `${viewName} - zitadel`;
  }

  // WebSocket
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // exponential backoff for reconnect. base 2s doubling per failure,
  // capped at 60s, with up-to-1s of jitter so a fleet of clients
  // returning after a relay outage doesn't synchronize their reconnect
  // and DDoS the relay back down. attempts resets to 0 on successful
  // open. retryTimer holds the pending setTimeout so /connect can
  // cancel it for an immediate retry.
  let reconnectAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleReconnect() {
    const baseMs = Math.min(60_000, 2_000 * Math.pow(2, reconnectAttempts));
    const jitterMs = Math.floor(Math.random() * 1000);
    const delayMs = baseMs + jitterMs;
    reconnectAttempts += 1;
    addMsg('zitadel',
      `reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})`,
      true);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; connectRelay(); }, delayMs);
  }

  function connectRelay() {
    addMsg('zitadel', `connecting to relay...`, true);
    try {
      ws = new WebSocket(relayUrl);
    } catch (e) {
      addMsg('zitadel', `ws error: ${e}`, true);
      return;
    }

    ws.onopen = () => {
      connected = true;
      reconnectAttempts = 0;
      addMsg('zitadel', 'connected to relay', true);
      // rejoin whatever room the user was on, falling back to the
      // initial default. without this, a mid-session disconnect would
      // yank the user out of #foo back to #zitadel on every reconnect.
      // currentRoom is preserved across onclose specifically so we
      // can rejoin here.
      const targetRoom = currentRoom || initialRoom;
      wsSend({ t: 'join', room: targetRoom, nick });
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
            // nick -> pubkey bindings are intentionally NOT taken from
            // unverified relay-side fields. they come only from
            // verified zid-auth-v1 announces or zid-msg-v1 envelopes
            // (handled below). a compromised or future relay must not
            // be able to inject identity claims by attaching a pubkey
            // field to a 'msg' broadcast.
            // legacy: drop messages flagged enc=true. previous client
            // versions encrypted with a deterministic HKDF-from-room-name
            // key (room-key mode), which has been removed. those payloads
            // would render as raw {"ct":"...","iv":"..."} envelopes if
            // shown verbatim, so suppress them silently.
            if (msg.enc) {
              console.debug('[zitadel] dropping legacy enc=true message',
                `(room=${msg.room ?? currentRoom ?? '?'})`);
              break;
            }
            // zid-msg-v1: if text parses as a signed envelope, verify
            // before rendering. unsigned messages still render but
            // won't earn the verified `+` mark. binding room and
            // server into the signature prevents cross-room replay.
            let visibleText: string = msg.text;
            let senderPubkey: string | undefined;
            let msgVerified = false;
            if (typeof msg.text === 'string' && msg.text.startsWith('{')) {
              try {
                const obj = JSON.parse(msg.text);
                if (obj && obj.v === ZID_MSG_VERSION) {
                  const proof = verifyMsg(obj, relayHost(relayUrl));
                  if (!proof || proof.room !== currentRoom) {
                    console.debug('[zitadel] zid-msg verify failed, dropping',
                      { nick: msg.nick, room: obj.room });
                    break;
                  }
                  const existing = nickToPubkey.get(proof.nick);
                  if (existing && existing !== proof.pubkey) {
                    console.debug('[zitadel] zid-msg nick collision, dropping',
                      { nick: proof.nick, existing: existing.slice(0, 16),
                        new: proof.pubkey.slice(0, 16) });
                    warnCollision(proof.nick, proof.pubkey, 'msg');
                    break;
                  }
                  rebindIdentity(proof.nick, proof.pubkey);
                  visibleText = proof.text;
                  senderPubkey = proof.pubkey;
                  msgVerified = true;
                }
              } catch { /* not JSON, treat as legacy cleartext */ }
            }
            // pubkey-based ignore: if we resolved a pubkey for this
            // sender via the verified envelope, or from a previously
            // verified nick→pubkey binding, and it's in the ignore
            // set, drop silently. nick lookup is allowed because nick
            // bindings come only from verified paths (iter 31).
            const senderPub = senderPubkey || nickToPubkey.get(msg.nick);
            if (senderPub && ignoredPubkeys.has(senderPub.toLowerCase())) break;
            // detect IRC-style /me action via CTCP marker. for signed
            // messages, the marker travels inside the signature so it
            // can't be added or stripped without invalidating the proof.
            const isAction = isActionText(visibleText);
            const renderText = isAction ? stripAction(visibleText) : visibleText;
            addMsg(msg.nick, renderText, false, msg.room || currentRoom || undefined, false, isAction, msgVerified);
            break;
          }
          case 'joined':
            currentRoom = msg.room;
            joinedRooms.add(msg.room);
            joinRetried = false;
            addMsg('zitadel', `joined #${msg.room} (${msg.count} users)`, true);
            if (!activeDm) encState = 'public';
            // announce our ZID identity to the room - only when we
            // can actually sign. an unsigned announce was wire-noise:
            // receivers run verifyAnnounce which rejects anything
            // without a valid v/sig, so the unsigned form was
            // pretending to be an identity claim while contributing
            // nothing. quiet beats dishonest.
            if (zidPubkey && zidPrivkey) {
              const proof = signAnnounce(zidPrivkey, zidPubkey, nick, relayHost(relayUrl));
              wsSend({ t: 'announce', ...proof });
              // self-verified: we just signed our own announce
              verifiedNicks.add(nick);
            }
            render();
            break;
          case 'announce': {
            // peer claiming a nick. verify under zid-auth-v1 before
            // we trust the nick -> pubkey binding. first-claim-wins:
            // if we already have a binding for this nick to a
            // different pubkey, we keep the original and ignore the
            // new one (logged for visibility).
            const proof = verifyAnnounce(msg, relayHost(relayUrl));
            if (!proof) {
              console.debug('[zitadel] announce failed verification, ignoring',
                { nick: msg.nick, pubkey: msg.pubkey?.slice(0, 16) });
              break;
            }
            // pubkey-based ignore applies to announces too: don't even
            // bind a nick for this identity, otherwise the join/verify
            // chrome would still surface them.
            if (ignoredPubkeys.has(proof.pubkey.toLowerCase())) break;
            const existing = nickToPubkey.get(proof.nick);
            if (existing && existing !== proof.pubkey) {
              console.debug('[zitadel] announce nick collision, keeping first binding',
                { nick: proof.nick, existing: existing.slice(0, 16), new: proof.pubkey.slice(0, 16) });
              warnCollision(proof.nick, proof.pubkey, 'announce');
              break;
            }
            const wasVerified = verifiedNicks.has(proof.nick);
            rebindIdentity(proof.nick, proof.pubkey);
            // first-time verification announcement, so the user sees
            // it surface in chat (vs silently flipping the +).
            if (!wasVerified) {
              addMsg('zitadel',
                `+${proof.nick} verified (zid ${proof.pubkey.slice(0, 16)})`,
                true, msg.room || currentRoom || undefined);
              render();
            }
            break;
          }
          case 'created':
            addMsg('zitadel', `room created: ${msg.room}`, true);
            // auto-join the room we just created
            wsSend({ t: 'join', room: msg.room, nick });
            break;
          case 'left':
            addMsg('zitadel', `${msg.nick} left (${msg.count} users)`, true);
            break;
          // 'users' (a relay-supplied roster with nick/pubkey pairs)
          // intentionally has no handler. binding identities from an
          // unverified roster would let the relay forge nick→pubkey
          // pairings; under zid-auth-v1 each peer must self-announce
          // and prove possession of its key.
          case 'system':
            addMsg('zitadel', msg.text, true);
            break;
          case 'error':
            // if room doesn't exist, only Pro users may create one.
            // free users can join any existing room but cannot mint
            // new ones (channels are persistent state on the relay).
            if (msg.msg === 'room not found or expired' && !joinRetried) {
              joinRetried = true;
              if (await isProUser()) {
                addMsg('zitadel', 'room not found, creating...', true);
                wsSend({ t: 'create', nick, room: initialRoom });
              } else {
                addMsg('zitadel', `room not found. creating channels requires zafu pro.`, true);
              }
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
      scheduleReconnect();
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

  /** Print self-whois (own identity card) into chat. Same body as
   * `/whois` with no arg - extracted so the sidebar identity chip can
   * call it on click without simulating a slash command. */
  function runSelfWhois() {
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
  }

  /** Run the /login flow. Tries to open the wallet popup, re-resolves
   * identity, re-announces on success. Extracted so the sidebar chip
   * can call it without dispatching a slash command. */
  async function runLogin() {
    if (zidPrivkey) {
      addMsg('zitadel', `already logged in as ${shortPub(zidPubkey!)}.`, true);
      return;
    }
    try {
      const action = (chrome as unknown as { action?: { openPopup?: () => Promise<void> } }).action;
      if (action?.openPopup) await action.openPopup();
    } catch { /* popup may be unavailable or already open */ }
    addMsg('zitadel', 'resolving identity...', true);
    const zid = await resolveZidIdentity();
    loggedIn = zid.loggedIn;
    zidPubkey = zid.pubkey;
    zidPrivkey = zid.privkey;
    if (!zid.pubkey) {
      addMsg('zitadel', 'no zafu identity found. install/create a wallet first.', true);
      return;
    }
    if (!zid.privkey) {
      addMsg('zitadel', 'wallet still locked. click the zafu icon in the toolbar to unlock, then try again.', true);
      return;
    }
    addMsg('zitadel', `logged in. zid: ${shortPub(zid.pubkey)} - messages will now carry zid-msg-v1 signatures.`, true);
    if (currentRoom) {
      const proof = signAnnounce(zid.privkey, zid.pubkey, nick, relayHost(relayUrl));
      wsSend({ t: 'announce', ...proof });
      verifiedNicks.add(nick);
      render();
    }
  }

  /** Send a room message, optionally as a /me action. Wraps in
   * zid-msg-v1 when the wallet is unlocked - the action marker is
   * inside the signed payload so it's bound to the proof. */
  function sendRoomMessage(text: string, action = false) {
    if (!connected) { addMsg('zitadel', 'not connected. type /connect', true); return; }
    if (!currentRoom) { addMsg('zitadel', 'not in a channel. type /j <room>', true); return; }
    const wireText = action ? `${ACTION_PREFIX}${text}${ACTION_SUFFIX}` : text;
    const signed = !!(zidPrivkey && zidPubkey);
    if (signed) {
      const proof = signMsg(zidPrivkey!, zidPubkey!, nick, currentRoom, relayHost(relayUrl), wireText);
      wsSend({ t: 'msg', text: JSON.stringify(proof) });
    } else {
      wsSend({ t: 'msg', text: wireText });
    }
    // self-echo carries our own verified state so locally-rendered
    // sent messages get the same `+` semantics as peer messages: only
    // shown when the message was actually signed.
    addMsg(nick, text, false, undefined, false, action, signed);
  }

  // command hints
  const CMDS: Record<string, string> = {
    '/nick':     '/nick <name>        change your nickname',
    '/me':       '/me <action>        send an IRC action ("* nick ...")',
    '/j':        '/j <room>           join or create a channel',
    '/part':     '/part               leave current channel',
    '/msg':      '/msg <target> <text>  DM (nick or pubkey)',
    '/dm':       '/dm <pubkey> <text>   DM by explicit pubkey',
    '/channels': '/channels           list open DM channels',
    '/close':    '/close [pubkey]     close a DM channel',
    '/whois':    '/whois              show ZID identity + status',
    '/share':    '/share [nick|pub]   copy a zid pubkey to clipboard',
    '/ignore':   '/ignore <nick|pub>  silence a pubkey (persists)',
    '/unignore': '/unignore <nick|pub> remove from ignore list',
    '/ignored':  '/ignored            list ignored pubkeys',
    '/login':    '/login              unlock zafu and sign messages',
    '/notify':   '/notify [on|off]    desktop alerts on mention/DM',
    '/clear':    '/clear              clear messages',
    '/connect':  '/connect            reconnect to relay',
    '/server':   '/server <url|reset> change relay (wss://...)',
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
    // Esc abandons the in-progress input. Terminal/IRC muscle memory:
    // start typing a command, change your mind, Esc cleans up. Resets
    // history index and tab cycle so the next ArrowUp / Tab starts
    // fresh instead of continuing from the abandoned context.
    if (e.key === 'Escape') {
      e.preventDefault();
      inp.value = '';
      histIdx = -1;
      tabState = null;
      return;
    }
    if (e.key === 'ArrowUp') { if (histIdx < history.length - 1) { histIdx++; inp.value = history[histIdx] ?? ''; } return; }
    if (e.key === 'ArrowDown') { if (histIdx > 0) { histIdx--; inp.value = history[histIdx] ?? ''; } else { histIdx = -1; inp.value = ''; } return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      // Tab completion. cycles through matches on repeated Tab. two
      // sources depending on the prefix: slash commands when the
      // prefix starts with `/` (drawn from the CMDS table so /help
      // and tab agree about what exists), nicks otherwise (drawn from
      // the announced nick→pubkey map so completions only fire for
      // peers we've actually heard from).
      if (!tabState) {
        const value = inp.value;
        const cursor = inp.selectionStart ?? value.length;
        const upToCursor = value.slice(0, cursor);
        // last whitespace-separated token
        const m = upToCursor.match(/(?:^|\s)([^\s]*)$/);
        const prefix = m?.[1] ?? '';
        if (!prefix) return; // nothing to complete
        const before = upToCursor.slice(0, upToCursor.length - prefix.length);
        const after = value.slice(cursor);
        const candidates: string[] = [];
        const isCmd = prefix.startsWith('/') && before === '';
        if (isCmd) {
          for (const c of Object.keys(CMDS)) {
            if (c.toLowerCase().startsWith(prefix.toLowerCase())) candidates.push(c);
          }
        } else {
          for (const n of nickToPubkey.keys()) {
            if (n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== nick) candidates.push(n);
          }
        }
        candidates.sort();
        if (!candidates.length) return;
        tabState = { prefix, before, after, matches: candidates, idx: 0 };
      } else {
        tabState.idx = (tabState.idx + 1) % tabState.matches.length;
      }
      const completion = tabState.matches[tabState.idx]!;
      // suffix logic depends on what was completed:
      //   - slash command at start: " " so the user can type args.
      //   - nick at start of line: ": " (IRC convention - addressing).
      //   - nick mid-message: " " (just a separator).
      const isCmdCompletion = completion.startsWith('/');
      const suffix = isCmdCompletion
        ? ' '
        : (tabState.before === '' ? ': ' : ' ');
      const next = tabState.before + completion + suffix + tabState.after;
      inp.value = next;
      const newCursor = tabState.before.length + completion.length + suffix.length;
      inp.setSelectionRange(newCursor, newCursor);
      return;
    }
    // any other key resets the tab cycle
    tabState = null;
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
          addMsg('zitadel', '── commands ─────────────────────────', true);
          addMsg('zitadel', '  channels:  /j /part (or /leave) /channels /clear', true);
          addMsg('zitadel', '  messages:  /me <text>   (action)', true);
          addMsg('zitadel', '  DMs:       /msg <nick|pub> <text>   /dm <pub> <text>   /close', true);
          addMsg('zitadel', '  identity:  /login   /nick <name>   /whois [nick|pub]   /share [nick|pub]', true);
          addMsg('zitadel', '  safety:    /ignore /unignore /ignored', true);
          addMsg('zitadel', '  config:    /server <url|reset>   /notify [on|off]   /connect', true);
          addMsg('zitadel', '── keyboard ─────────────────────────', true);
          addMsg('zitadel', '  Tab        complete /command or peer nick', true);
          addMsg('zitadel', '  Alt+1..9   switch to that channel/DM by index (Alt+0 = 10th)', true);
          addMsg('zitadel', '  ↑ ↓        navigate input history', true);
          addMsg('zitadel', '  Esc        clear input', true);
          addMsg('zitadel', '── identity ─────────────────────────', true);
          addMsg('zitadel', '  Public messages are signed under zid-msg-v1 (per-message ed25519).', true);
          addMsg('zitadel', '  Verified peers show a green + on their nick. Click a nick to DM.', true);
          addMsg('zitadel', '  DMs use Noise IK end-to-end encryption (the [e2ee] tag).', true);
          break;

        case 'nick':
          if (args[0]) {
            if (!isValidNick(args[0])) {
              addMsg('zitadel', `invalid nick. 1-32 chars, no whitespace.`, true);
              break;
            }
            const old = nick;
            nick = args[0];
            // persist the binding so the same ZID gets the same nick
            // next session. ephemeral sessions (no zidPubkey) don't
            // persist - the random anon prefix is regenerated each load.
            if (zidPubkey && localStore) {
              void localStore.set({ [ZID_NICK_PREFIX + zidPubkey]: nick });
            }
            addMsg('zitadel', `${old} is now known as ${nick}`, true);
            // re-announce so peers in the current room learn the new
            // binding under a fresh zid-auth-v1 proof. without this,
            // peers keep showing the old nick until reconnect.
            if (currentRoom && zidPubkey && zidPrivkey) {
              const proof = signAnnounce(zidPrivkey, zidPubkey, nick, relayHost(relayUrl));
              wsSend({ t: 'announce', ...proof });
              verifiedNicks.add(nick);
            }
            render();
          }
          break;

        case 'me': {
          // /me <action> - IRC convention. renders as "* nick text".
          const actionText = args.join(' ').trim();
          if (!actionText) { addMsg('zitadel', 'usage: /me <action>', true); break; }
          sendRoomMessage(actionText, true);
          break;
        }

        case 'j': case 'join':
          if (args[0]) { switchRoom(args[0]); }
          else addMsg('zitadel', 'usage: /j <room>', true);
          break;

        case 'server':
          if (!args[0]) {
            addMsg('zitadel', `current relay: ${relayUrl}`, true);
            addMsg('zitadel', 'usage: /server <wss://host/path> | /server reset', true);
            break;
          }
          if (args[0] === 'reset') {
            relayUrl = DEFAULT_RELAY_WS;
            void localStore?.remove(RELAY_URL_KEY);
            addMsg('zitadel', `relay reset to ${relayUrl}, reconnecting...`, true);
          } else if (!isValidRelayUrl(args[0])) {
            addMsg('zitadel', `invalid relay url: ${args[0]} (expected wss://... or ws://...)`, true);
            break;
          } else {
            relayUrl = args[0];
            void localStore?.set({ [RELAY_URL_KEY]: relayUrl });
            addMsg('zitadel', `relay set to ${relayUrl}, reconnecting...`, true);
          }
          // close the existing socket; onclose schedules a reconnect
          // with the new URL via exponential backoff. clear all state
          // that was scoped to the old relay:
          //
          // - nick↔pubkey bindings: zid-auth-v1 binds the server name
          //   into the signature, so old-server proofs don't apply on
          //   the new server.
          // - DM Noise sessions: the channels were established over
          //   the old relay's participant routing; closing them here
          //   releases the keys and forces fresh handshakes.
          // - collision dedupe: warnings about pubkey X claiming nick
          //   alice on the old server don't apply to the new universe.
          //
          // ignoredPubkeys is intentionally NOT cleared - the user's
          // ignore preferences are pubkey-keyed, server-independent.
          nickToPubkey.clear();
          pubkeyToNick.clear();
          verifiedNicks.clear();
          collisionWarned.clear();
          for (const ch of dmChannels.values()) ch.close();
          dmChannels.clear();
          if (activeDm) { activeDm = null; encState = 'public'; }
          if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
          render();
          break;

        case 'part': case 'leave':
          partActiveView();
          break;

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
          if (zidPubkey && target.toLowerCase() === zidPubkey.toLowerCase()) {
            addMsg('zitadel', `can't DM yourself.`, true);
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
          if (zidPubkey && args[0].toLowerCase() === zidPubkey.toLowerCase()) {
            addMsg('zitadel', `can't DM yourself.`, true);
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
          // /whois with no arg: print your own identity (self-whois).
          // /whois <nick> or /whois <pubkey>: look up a peer in the
          // current room. matches IRC convention - the question users
          // actually ask is "who is alice", not "who am I". pubkey
          // lookup is the safer query (immune to nick collisions);
          // nick lookup falls back to first-claim-wins binding.
          const target = args[0];
          if (!target) {
            runSelfWhois();
          } else {
            // peer lookup: accept either a hex pubkey or a nick.
            let peerNick: string | undefined;
            let peerPubkey: string | undefined;
            if (isHexPubkey(target)) {
              peerPubkey = target.toLowerCase();
              peerNick = pubkeyToNick.get(peerPubkey);
            } else {
              peerNick = target;
              peerPubkey = nickToPubkey.get(target);
            }
            if (!peerPubkey) {
              addMsg('zitadel', `whois: no binding for ${target}. they may not have announced under zid-auth-v1.`, true);
            } else {
              const verified = peerNick && verifiedNicks.has(peerNick);
              addMsg('zitadel', `--- whois ${peerNick ?? '(no nick)'} ---`, true);
              addMsg('zitadel', `nick: ${peerNick ?? '(unbound)'}`, true);
              addMsg('zitadel', `pubkey: ${peerPubkey}`, true);
              addMsg('zitadel', `zid: ${shortPub(peerPubkey)}`, true);
              addMsg('zitadel', `verified: ${verified ? 'yes (zid-auth-v1)' : 'no - nick claim is unsigned'}`, true);
            }
          }
          break;
        }

        case 'share': {
          // /share          copy your own zid pubkey to clipboard
          // /share <target> copy that peer's pubkey (nick or hex)
          // Slash dispatch runs under the Enter keypress so we have
          // the user gesture the clipboard API requires.
          let pub: string | undefined;
          let label: string;
          if (!args[0]) {
            if (!zidPubkey) { addMsg('zitadel', 'no zafu identity to share. /login first.', true); break; }
            pub = zidPubkey;
            label = 'your zid';
          } else if (isHexPubkey(args[0])) {
            pub = args[0].toLowerCase();
            label = pubkeyToNick.get(pub) ?? shortPub(pub);
          } else {
            pub = nickToPubkey.get(args[0]);
            if (!pub) { addMsg('zitadel', `no pubkey known for ${args[0]}. they must announce first.`, true); break; }
            label = args[0];
          }
          try {
            await navigator.clipboard.writeText(pub);
            addMsg('zitadel', `copied ${label} pubkey to clipboard: ${pub}`, true);
          } catch (e) {
            addMsg('zitadel', `clipboard failed: ${e instanceof Error ? e.message : String(e)}. pubkey: ${pub}`, true);
          }
          break;
        }

        case 'ignore': {
          // /ignore <pubkey or nick>. accept either form because users
          // think in nicks, but persist as pubkey so a renamed peer
          // stays silenced. unbound nicks are an error - we have no
          // pubkey to record.
          const target = args[0];
          if (!target) { addMsg('zitadel', 'usage: /ignore <nick|pubkey>', true); break; }
          let pub: string | undefined;
          if (isHexPubkey(target)) pub = target.toLowerCase();
          else pub = nickToPubkey.get(target);
          if (!pub) { addMsg('zitadel', `no pubkey known for ${target}. they must announce first.`, true); break; }
          if (zidPubkey && pub === zidPubkey.toLowerCase()) {
            addMsg('zitadel', 'refusing to ignore your own ZID.', true);
            break;
          }
          ignoredPubkeys.add(pub);
          if (localStore) void localStore.set({ [ZID_IGNORE_KEY]: Array.from(ignoredPubkeys) });
          addMsg('zitadel', `ignoring ${pubkeyToNick.get(pub) ?? shortPub(pub)} (${pub.slice(0, 16)}...)`, true);
          break;
        }

        case 'unignore': {
          const target = args[0];
          if (!target) { addMsg('zitadel', 'usage: /unignore <nick|pubkey>', true); break; }
          let pub: string | undefined;
          if (isHexPubkey(target)) pub = target.toLowerCase();
          else pub = nickToPubkey.get(target);
          if (!pub || !ignoredPubkeys.has(pub)) {
            addMsg('zitadel', `${target} is not in the ignore list.`, true);
            break;
          }
          ignoredPubkeys.delete(pub);
          if (localStore) void localStore.set({ [ZID_IGNORE_KEY]: Array.from(ignoredPubkeys) });
          addMsg('zitadel', `no longer ignoring ${pubkeyToNick.get(pub) ?? shortPub(pub)}.`, true);
          break;
        }

        case 'ignored': {
          if (ignoredPubkeys.size === 0) {
            addMsg('zitadel', 'ignore list is empty.', true);
            break;
          }
          addMsg('zitadel', `--- ignored (${ignoredPubkeys.size}) ---`, true);
          for (const p of ignoredPubkeys) {
            const knownNick = pubkeyToNick.get(p);
            addMsg('zitadel', `  ${knownNick ?? shortPub(p)}  ${p}`, true);
          }
          break;
        }

        case 'login':
          await runLogin();
          break;

        case 'notify': {
          // /notify        - status / toggle
          // /notify on     - request permission if needed, enable
          // /notify off    - disable
          const arg = args[0]?.toLowerCase();
          if (typeof Notification === 'undefined') {
            addMsg('zitadel', 'desktop notifications not supported in this browser.', true);
            break;
          }
          if (arg === 'off') {
            notifyEnabled = false;
            if (localStore) void localStore.remove(ZID_NOTIFY_KEY);
            addMsg('zitadel', 'desktop notifications: off', true);
            break;
          }
          // any other arg (or none) means turn on. ask for permission
          // if we don't already have it. /notify is dispatched from
          // the Enter keypress so we have a user gesture - the
          // permission prompt will actually appear.
          if (Notification.permission === 'denied') {
            addMsg('zitadel', 'browser blocked notifications. allow them in site settings, then /notify again.', true);
            break;
          }
          if (Notification.permission === 'default') {
            const result = await Notification.requestPermission();
            if (result !== 'granted') {
              addMsg('zitadel', `notifications not enabled (browser said: ${result}).`, true);
              break;
            }
          }
          notifyEnabled = true;
          if (localStore) void localStore.set({ [ZID_NOTIFY_KEY]: '1' });
          addMsg('zitadel', 'desktop notifications: on - alerts on mention or DM while tab is hidden. /notify off to stop.', true);
          break;
        }

        case 'connect':
          if (connected) { addMsg('zitadel', 'already connected', true); break; }
          // /connect bypasses any pending backoff: cancel the timer,
          // reset attempts, try immediately. matches the user's intent
          // ("retry now") rather than making them wait for the next
          // scheduled tick.
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          reconnectAttempts = 0;
          connectRelay();
          break;

        case 'clear':
          // emptying the array isn't enough - render's append path
          // can't shrink the DOM. force a full rebuild by resetting
          // the per-view bookkeeping. otherwise the data is gone but
          // the screen still shows the old lines.
          roomMessages().length = 0;
          renderedView = null;
          renderedCount.delete(currentViewKey());
          firstNewIdx.delete(currentViewKey());
          render();
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

      // send to relay (room message). public rooms are cleartext - the
      // relay sees the message bytes. sendRoomMessage handles signing,
      // wrapping, and the connection-state error paths.
      sendRoomMessage(text);
    }
  });

  // react to wallet lock/unlock from elsewhere. when the user locks
  // zafu in another tab, the session-store entry "passwordKey" is
  // cleared - we use that as the lock signal, drop the privkey from
  // memory, and surface the state change. without this, the chat
  // would keep signing under the now-revoked unlock for the rest of
  // the session, which is exactly the stale-credentials hazard the
  // user was trying to avoid by locking.
  try {
    chrome?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'session') return;
      const change = changes['passwordKey'];
      if (!change) return;
      // newValue absent => key was removed => wallet was just locked
      if (change.newValue === undefined && zidPrivkey) {
        zidPrivkey = undefined;
        addMsg('zitadel',
          'wallet locked - new messages will be unsigned. /login to re-enable signing.',
          true);
        render();
      }
    });
  } catch { /* not in extension context */ }

  // init
  resolveZidIdentity().then(async (zid) => {
    loggedIn = zid.loggedIn;
    zidPubkey = zid.pubkey;
    zidPrivkey = zid.privkey;

    if (zid.pubkey) {
      // default to derived shortPub; overridden below if we have a
      // persisted /nick choice for this ZID.
      nick = shortPub(zid.pubkey);
      if (localStore) {
        try {
          const key = ZID_NICK_PREFIX + zid.pubkey;
          const r = await new Promise<Record<string, unknown>>(res => localStore.get(key, res));
          const stored = r?.[key];
          if (typeof stored === 'string' && isValidNick(stored)) {
            nick = stored;
          }
        } catch { /* not in extension context */ }
      }
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
    // load persisted relay choice (if any) before opening the socket
    if (localStore) {
      try {
        const saved = await new Promise<Record<string, unknown>>(r => localStore.get(RELAY_URL_KEY, r));
        const candidate = saved?.[RELAY_URL_KEY];
        if (typeof candidate === 'string' && isValidRelayUrl(candidate)) {
          relayUrl = candidate;
        }
      } catch { /* not in extension context */ }
      // load persisted ignore list - pubkeys are kept across sessions so
      // a peer you silenced in one session stays silent in the next.
      try {
        const r = await new Promise<Record<string, unknown>>(res => localStore.get(ZID_IGNORE_KEY, res));
        const stored = r?.[ZID_IGNORE_KEY];
        if (Array.isArray(stored)) {
          for (const p of stored) if (typeof p === 'string' && isHexPubkey(p)) ignoredPubkeys.add(p.toLowerCase());
        }
      } catch { /* not in extension context */ }
      // load notification opt-in. only honor it if the browser has
      // already granted permission - otherwise the user has to /notify
      // again to re-prompt (cleaner than silently noop'ing forever).
      try {
        const r = await new Promise<Record<string, unknown>>(res => localStore.get(ZID_NOTIFY_KEY, res));
        if (r?.[ZID_NOTIFY_KEY] === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          notifyEnabled = true;
        }
      } catch { /* not in extension context */ }
    }
    addMsg('zitadel', `relay: ${relayUrl}`, true);
    render();
    // auto-connect to relay and join initial room
    connectRelay();
  });
}

boot();
