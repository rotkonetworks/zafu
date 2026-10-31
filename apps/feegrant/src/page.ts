import type { IncomingHttpHeaders } from 'node:http';
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

const section = (name: string, n: NetworkStats): string => {
  const known = n.balance !== null && n.capacity !== null;
  return `<section>
<h2>${name}</h2>
<p class="label">donate ${n.symbol} here to keep it running</p>
<p class="addr"><a href="${esc(n.addressUrl)}" rel="noopener">${esc(n.sponsor)}</a>
<button type="button" data-copy="${esc(n.sponsor)}">copy</button></p>
<dl>
<div><dt>balance</dt><dd>${known ? `${esc(n.balance ?? '')} ${n.symbol}` : 'not readable just now'}</dd></div>
<div><dt>capacity</dt><dd>${known ? `enough for about ${n.capacity} more people` : 'please check again in a minute'}</dd></div>
<div><dt>today</dt><dd>${n.today} of ${n.dailyCap}</dd></div>
</dl>
${
  n.records.length
    ? `<table><thead><tr><th>time</th><th>amount</th><th>to</th><th>tx</th></tr></thead><tbody>${n.records.map(r => row(n.symbol, r)).join('')}</tbody></table>`
    : '<p class="label">nothing in the last day</p>'
}
</section>`;
};

const CSS = `
:root{--bg:#0c0a08;--card:#131009;--line:#322a21;--soft:#241f18;--high:#f2ecdf;--fg:#ded5c4;--muted:#948a79;--gold:#f4b728}
@media(prefers-color-scheme:light){:root{--bg:#efe9dc;--card:#f6f2e8;--line:#c9bda7;--soft:#ddd3c1;--high:#171310;--fg:#2b241c;--muted:#6f6555;--gold:#8a6508}}
*{box-sizing:border-box;border-radius:0}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 'Iosevka Term','Courier New',Courier,monospace}
main{max-width:720px;margin:0 auto;padding:48px 16px}
h1,h2{color:var(--high);font-weight:600;margin:0}
h1{font-size:20px}h2{font-size:16px;margin-bottom:12px}
section{border-top:1px solid var(--line);margin-top:32px;padding-top:24px}
p{margin:0 0 12px}.label{color:var(--muted)}
a{color:var(--gold)}
.addr{word-break:break-all}
button{font:inherit;background:none;color:var(--fg);border:1px solid var(--line);padding:0 8px;margin-left:8px;cursor:pointer}
dl{margin:16px 0}dl div{display:flex;gap:16px;border-bottom:1px solid var(--soft);padding:4px 0}
dt{color:var(--muted);width:96px;flex:none}dd{margin:0;color:var(--high)}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--soft);white-space:nowrap}
th{color:var(--muted);font-weight:400}
@media(max-width:600px){main{overflow-x:auto}}`;

const JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(b)navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='copied';setTimeout(()=>{b.textContent='copy'},1500)})})`;

export const renderPage = (s: Stats): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zafu sponsor</title>
<style>${CSS}</style></head><body><main>
<h1>zafu sponsor</h1>
<p class="label">zafu pays the first bit of gas for people who have none. everything below is read from the chain.</p>
${section('injective', s.injective)}
${s.base ? section('base', s.base) : ''}
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
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
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
