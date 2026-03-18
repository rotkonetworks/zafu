// zitadel: shielded lobby served locally from the zafu extension.
// plain DOM, zero framework deps. WebSocket to relay.zk.bot.

export const RELAY_WS = "wss://relay.zk.bot/ws";

const C = {
  bg: "#0F0F1A", panel: "#16162A", border: "#2A2A4A",
  gold: "#F4B728", amber: "#D4991A", muted: "#6B6B8D",
  text: "#C8C8E0", bright: "#E8E8FF", green: "#4ADE80", red: "#F87171",
  cyan: "#22D3EE", purple: "#A78BFA",
};

interface Msg { nick: string; text: string; time: string; system?: boolean; color?: string }

const NICK_COLORS = [C.gold, C.cyan, C.green, C.purple, C.red, "#60A5FA", "#FB923C", "#E879F9", "#FBBF24", "#34D399"];
function nickColor(n: string) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return NICK_COLORS[Math.abs(h) % NICK_COLORS.length]; }

const sessionStore = typeof chrome !== 'undefined' ? chrome?.storage?.session : undefined;

async function checkLogin(): Promise<{ loggedIn: boolean; identity?: string }> {
  if (!sessionStore) return { loggedIn: false };
  try {
    const result: Record<string, unknown> = await new Promise(r => sessionStore.get('passwordKey', r));
    if (result?.['passwordKey']) {
      const raw = new TextEncoder().encode(JSON.stringify(result['passwordKey']));
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      return { loggedIn: true, identity: Array.from(hash.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('') };
    }
  } catch { /* not in extension */ }
  return { loggedIn: false };
}

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

  // state
  let nick = '...';
  let loggedIn = false;
  let identity: string | undefined;
  let currentRoom: string | null = null;
  let ws: WebSocket | null = null;
  let connected = false;
  const messages: Msg[] = [];
  const history: string[] = [];
  let histIdx = -1;

  // DOM
  root.style.cssText = `background:${C.bg};color:${C.text};font-family:'IBM Plex Mono',monospace;font-size:14px;height:100vh;display:flex;flex-direction:column;`;
  const topbar = mkEl('div', `background:${C.panel};border-bottom:1px solid ${C.border};padding:6px 12px;display:flex;align-items:center;gap:8px;`);
  const msgArea = mkEl('div', `flex:1;overflow-y:auto;padding:8px 12px;`);
  const statusEl = mkEl('div', `background:${C.panel};border-top:1px solid ${C.border};padding:4px 12px;font-size:11px;color:${C.muted};display:flex;gap:16px;`);
  const bar = mkEl('div', `background:${C.bg};border-top:1px solid ${C.border};padding:8px 12px;display:flex;align-items:center;gap:8px;`);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.autofocus = true;
  inp.placeholder = 'type a message... (/ for commands)';
  inp.style.cssText = `flex:1;background:transparent;border:none;outline:none;color:${C.bright};font-family:inherit;font-size:inherit;caret-color:${C.gold};`;
  bar.appendChild(inp);
  root.append(topbar, msgArea, statusEl, bar);

  function mkEl(tag: string, css: string) { const e = document.createElement(tag); e.style.cssText = css; return e; }

  function addMsg(n: string, text: string, system = false) {
    messages.push({ nick: n, text, time: now(), system, color: system ? undefined : nickColor(n) });
    render();
  }

  function render() {
    const room = currentRoom || 'zitadel';
    const relayStatus = connected ? `<span style="color:${C.green}">ok</span>` : `<span style="color:${C.red}">--</span>`;
    topbar.innerHTML = `<b style="color:${C.bright}">#${esc(room)}</b><span style="color:${C.border}">|</span><span style="color:${C.muted}">shielded lobby | /help</span><span style="margin-left:auto;color:${C.muted}">relay: ${relayStatus}</span>`;

    msgArea.innerHTML = messages.map(m => {
      if (m.system) return `<div style="line-height:1.4"><span style="color:${C.muted}">${m.time}</span><span style="color:${C.gold}"> -!- </span><span style="color:${C.muted}">${esc(m.text)}</span></div>`;
      const col = m.color || C.gold;
      return `<div style="line-height:1.4"><span style="color:${C.muted}">${m.time}</span><span style="color:${C.border}"> &lt;</span><b style="color:${col}">${esc(m.nick)}</b><span style="color:${C.border}">&gt; </span>${esc(m.text)}</div>`;
    }).join('');
    msgArea.scrollTop = msgArea.scrollHeight;

    const tag = loggedIn ? `<span style="color:${C.green}">zafu</span>` : `<span style="color:${C.muted}">anon</span>`;
    statusEl.innerHTML = `<span>[<span style="color:${C.amber}">#${esc(room)}</span>]</span><span>[<span style="color:${C.gold}">${esc(nick)}</span>]</span><span>[${tag}]</span><span style="margin-left:auto">zitadel &#x2B21; zafu</span>`;

    bar.innerHTML = `<span style="color:${C.border}">[</span><b style="color:${C.gold}">${esc(nick)}</b><span style="color:${C.border}">]</span>`;
    bar.appendChild(inp);
    inp.focus();
  }

  // WebSocket
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
      // auto-join lobby (create if doesn't exist)
      wsSend({ t: 'join', room: 'zitadel', nick });
    };

    let joinRetried = false;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        switch (msg.t) {
          case 'msg':
            if (msg.nick !== nick) {
              messages.push({ nick: msg.nick, text: msg.text, time: now(), color: nickColor(msg.nick) });
              render();
            }
            break;
          case 'joined':
            currentRoom = msg.room;
            joinRetried = false;
            addMsg('zitadel', `joined #${msg.room} (${msg.count} users)`, true);
            break;
          case 'created':
            addMsg('zitadel', `room created: ${msg.room}`, true);
            // auto-join the room we just created
            wsSend({ t: 'join', room: msg.room, nick });
            break;
          case 'left':
            addMsg('zitadel', `${msg.nick} left (${msg.count} users)`, true);
            break;
          case 'system':
            addMsg('zitadel', msg.text, true);
            break;
          case 'error':
            // if lobby doesn't exist, create it (persistent, TTL=0)
            if (msg.msg === 'room not found or expired' && !joinRetried) {
              joinRetried = true;
              addMsg('zitadel', 'lobby not found, creating...', true);
              wsSend({ t: 'create', nick, room: 'zitadel' });
            } else {
              addMsg('zitadel', `error: ${msg.msg}`, true);
            }
            break;
        }
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      connected = false;
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
    '/nick':    '/nick <name>     change your nickname',
    '/j':       '/j <room>        join or create a channel',
    '/part':    '/part             leave current channel',
    '/poker':   '/poker [code]    create or join poker table',
    '/msg':     '/msg <nick> <text>  private message',
    '/whois':   '/whois            show your identity + status',
    '/clear':   '/clear            clear messages',
    '/connect': '/connect          reconnect to relay',
    '/help':    '/help             show all commands',
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
          addMsg('zitadel', '/nick <name> | /j <room> | /part | /poker [code] | /msg <nick> <text> | /whois | /clear | /connect', true);
          break;
        case 'nick':
          if (args[0]) { const old = nick; nick = args[0]; addMsg('zitadel', `${old} is now known as ${nick}`, true); render(); }
          break;
        case 'j': case 'join':
          if (args[0]) { wsSend({ t: 'join', room: args[0], nick }); }
          else addMsg('zitadel', 'usage: /j <room>', true);
          break;
        case 'part':
          wsSend({ t: 'part' });
          currentRoom = null;
          addMsg('zitadel', 'left channel', true);
          render();
          break;
        case 'poker': {
          const room = args[0] || 'new';
          const pokerUrl = `https://zk.bot/poker?room=${room}`;
          addMsg('zitadel', `opening poker table${args[0] ? ' ' + args[0] : ''}...`, true);
          window.open(pokerUrl, '_blank');
        }
          break;
        case 'msg':
          if (args[0] && args[1]) {
            addMsg('zitadel', `DMs not yet implemented (TODO: private relay room with ${args[0]})`, true);
          } else addMsg('zitadel', 'usage: /msg <nick> <text>', true);
          break;
        case 'whois': {
          const id = identity;
          addMsg('zitadel', `you are ${nick} | room: ${currentRoom || 'none'} | ${loggedIn ? `zafu (${id?.slice(0, 16)}...)` : 'ephemeral'} | relay: ${connected ? 'ok' : 'disconnected'}`, true);
          break;
        }
        case 'connect':
          if (!connected) connectRelay();
          else addMsg('zitadel', 'already connected', true);
          break;
        case 'clear':
          messages.length = 0; render();
          break;
        default:
          addMsg('zitadel', `unknown: /${cmd}`, true);
      }
    } else {
      // send to relay
      if (connected && currentRoom) {
        wsSend({ t: 'msg', text });
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
  checkLogin().then(({ loggedIn: ok, identity: id }) => {
    loggedIn = ok;
    identity = id;
    nick = id ? 'user' + id.slice(0, 5) : 'anon' + String((Math.random() * 100000) | 0).padStart(5, '0');
    if (ok) addMsg('zitadel', `logged in via zafu (${id?.slice(0, 8)}...)`, true);
    else addMsg('zitadel', 'ephemeral session. connect zafu for persistent identity.', true);
    addMsg('zitadel', 'welcome to zitadel. type /help for commands.', true);
    render();
    // auto-connect to relay
    connectRelay();
  });
}

boot();
