import type { IncomingHttpHeaders } from 'node:http';
import QRCode from 'qrcode';
import { IOSEVKA, MINCHO } from './fonts';
import type { NetworkStats, Stats } from './stats';

export interface StatsResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Browsers ask for text/html; everything else, and header-less tools, gets JSON. */
export const wantsHtml = (accept: string | undefined, userAgent: string | undefined): boolean =>
  accept ? accept.includes('text/html') : (userAgent ?? '').startsWith('Mozilla/');

const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const short = (s: string): string => (s.length > 18 ? `${s.slice(0, 10)}...${s.slice(-6)}` : s);

const when = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} utc`;

const row = (symbol: string, r: NetworkStats['records'][number]): string =>
  `<tr><td>${when(r.time)}</td><td>${esc(r.amount)} ${symbol}</td>` +
  `<td title="${esc(r.to)}">${esc(short(r.to))}</td>` +
  `<td><a href="${esc(r.url)}" rel="noopener">${esc(short(r.txHash))}</a></td></tr>`;

/** what each sponsor pays for, and how a donation reaches it */
const NETWORKS = {
  injective: {
    title: 'injective',
    powers: [
      'pays the inj fee for people who hold usdc on injective but no inj, so they can shield it into penumbra.',
      'each grant covers about five transfers, only works for ibc transfers, and expires after a day.',
    ],
    qr: (a: string) => a,
  },
  base: {
    title: 'base',
    powers: [
      'sends a few cents of eth to a new base address, so someone buying zec through peer can sign their first transactions.',
      "one drip per address per day. only gas ever leaves this address, never anyone's funds.",
    ],
    // eip-681 with base's chain id, so a scanning wallet pays on base, not mainnet
    qr: (a: string) => `ethereum:${a}@8453`,
  },
} as const;

/** an svg qr code, drawn as one path so it stays a few kb */
const qrSvg = (text: string): string => {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  let d = '';
  data.forEach((on, i) => {
    if (on) {
      d += `M${(i % size) + 2} ${Math.floor(i / size) + 2}h1v1h-1z`;
    }
  });
  const n = size + 4;
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="qr code"><rect width="${n}" height="${n}" fill="#f6f2e8"/><path d="${d}" fill="#171310"/></svg>`;
};

const panel = (id: keyof typeof NETWORKS, n: NetworkStats): string => {
  const known = n.balance !== null && n.capacity !== null;
  const net = NETWORKS[id];
  return `<section class="panel" id="p-${id}">
<div class="powers">${net.powers.map(p => `<p>${p}</p>`).join('')}</div>
<dl>
<div><dt>balance</dt><dd>${known ? `${esc(n.balance ?? '')} ${n.symbol}` : 'not readable just now'}</dd></div>
<div><dt>capacity</dt><dd>${known ? `enough for about ${n.capacity} more people` : 'please check again in a minute'}</dd></div>
<div><dt>today</dt><dd>${n.today} of ${n.dailyCap}</dd></div>
</dl>
<h2>donate</h2>
<div class="donate">${qrSvg(net.qr(n.sponsor))}<div>
<p class="label">send ${n.symbol} on ${net.title} to this address to keep it running</p>
<p class="addr"><a href="${esc(n.addressUrl)}" rel="noopener">${esc(n.sponsor)}</a>
<button type="button" data-copy="${esc(n.sponsor)}">copy</button></p>
</div></div>
<h2>recent</h2>
${
  n.records.length
    ? `<div class="scroll"><table><thead><tr><th>time</th><th>amount</th><th>to</th><th>tx</th></tr></thead><tbody>${n.records.map(r => row(n.symbol, r)).join('')}</tbody></table></div>`
    : '<p class="label">nothing in the last day</p>'
}
</section>`;
};

const CSS = `
@font-face{font-family:'Iosevka Term';font-weight:400;src:url(${IOSEVKA}) format('woff2')}
@font-face{font-family:'Shippori Mincho';font-weight:500;src:url(${MINCHO}) format('woff2')}
:root{--bg:#0c0a08;--card:#131009;--line:#322a21;--soft:#241f18;--high:#f2ecdf;--fg:#ded5c4;--muted:#948a79;--gold:#f4b728}
@media(prefers-color-scheme:light){:root{--bg:#efe9dc;--card:#f6f2e8;--line:#c9bda7;--soft:#ddd3c1;--high:#171310;--fg:#2b241c;--muted:#6f6555;--gold:#8a6508}}
*{box-sizing:border-box;border-radius:0}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.7 'Iosevka Term',ui-monospace,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}
main{max-width:680px;margin:0 auto;padding:64px 20px}
h1,h2,dd{font-family:'Shippori Mincho',serif;font-weight:500;color:var(--high);margin:0}
h1{font-size:32px;letter-spacing:.01em;margin-bottom:8px}
h2{font-size:20px;margin:28px 0 12px}
input[name=tab]{position:absolute;opacity:0}
.tabs{display:flex;margin-top:40px;border-bottom:1px solid var(--line)}
.tabs label{font-family:'Shippori Mincho',serif;font-size:18px;color:var(--muted);padding:8px 20px;cursor:pointer;border:1px solid transparent;border-bottom:none;margin-bottom:-1px}
.tabs label:hover{color:var(--high)}
.panel{display:none;background:var(--card);border:1px solid var(--line);border-top:none;padding:24px}
#t-injective:checked~.tabs [for=t-injective],#t-base:checked~.tabs [for=t-base]{color:var(--high);background:var(--card);border-color:var(--line)}
#t-injective:checked~#p-injective,#t-base:checked~#p-base{display:block}
#t-injective:focus-visible~.tabs [for=t-injective],#t-base:focus-visible~.tabs [for=t-base]{outline:1px solid var(--gold)}
.powers p{margin-bottom:8px}
.donate{display:flex;gap:20px;align-items:center}.donate>div{flex:1;min-width:0}
.qr{width:148px;height:148px;flex:none;border:1px solid var(--line)}
.scroll{overflow-x:auto}
p{margin:0 0 12px}.label{color:var(--muted)}
a{color:var(--gold);text-decoration:none}a:hover{text-decoration:underline}
.addr{display:flex;gap:12px;align-items:center;border:1px solid var(--soft);padding:8px 12px;word-break:break-all}
.addr a{flex:1}
button{font:inherit;font-size:12px;background:none;color:var(--muted);border:1px solid var(--line);padding:2px 10px;cursor:pointer;flex:none}
button:hover{color:var(--high);border-color:var(--muted)}
dl{margin:20px 0}dl div{display:flex;gap:16px;align-items:baseline;border-bottom:1px solid var(--soft);padding:6px 0}
dt{color:var(--muted);width:96px;flex:none}dd{font-size:16px}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 12px 6px 0;border-bottom:1px solid var(--soft);white-space:nowrap}
th{color:var(--muted);font-weight:400}
@media(max-width:600px){main{padding:32px 12px}.panel{padding:16px}.donate{flex-direction:column;align-items:stretch}.qr{align-self:center}}`;

const JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(b)navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='copied';setTimeout(()=>{b.textContent='copy'},1500)})})`;

export const renderPage = (s: Stats): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zafu sponsor</title>
<style>${CSS}</style></head><body><main>
<h1>zafu sponsor</h1>
<p class="label">zafu pays the first bit of gas for people who have none, so a wallet that only holds dollars can still move them. it runs on donations. every number and record below is read from the chain.</p>
<input type="radio" name="tab" id="t-injective" checked>${s.base ? '<input type="radio" name="tab" id="t-base">' : ''}
<nav class="tabs"><label for="t-injective">injective</label>${s.base ? '<label for="t-base">base</label>' : ''}</nav>
${panel('injective', s.injective)}
${s.base ? panel('base', s.base) : ''}
<p class="label" style="margin-top:32px">updated ${when(s.updatedAt)} · refreshed at most once a minute</p>
</main><script>${JS}</script></body></html>`;

/** GET / (negotiated) and GET /v1/stats (`json` forced). */
export const handleStats = async (
  getStats: () => Promise<Stats>,
  headers: IncomingHttpHeaders,
  json: boolean,
): Promise<StatsResponse> => {
  const vary = { vary: 'Accept, User-Agent', 'cache-control': 'public, max-age=60' };
  const html = !json && wantsHtml(headers.accept, headers['user-agent']);
  const stats = await getStats();
  return html
    ? {
        status: 200,
        headers: {
          ...vary,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:",
        },
        body: renderPage(stats),
      }
    : {
        status: 200,
        headers: {
          ...vary,
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        },
        body: JSON.stringify(stats),
      };
};
