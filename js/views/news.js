// Crypto news, collected server-side from public RSS feeds every 20 minutes.
import { $, $$, skeleton, bindSeg, icon } from '../ui.js';
import { esc, ago } from '../format.js';
import { getNews, backendEnabled } from '../api/backend.js';

export const title = 'News';

export async function render(el, [coinParam]) {
  el.innerHTML = `
    <div class="page-head"><div><h1>News</h1><p>Headlines from major crypto outlets, refreshed every 20 minutes. Links open on the publisher's site.</p></div>
      <input class="inp" id="q" placeholder="Filter headlines…" style="max-width:240px"></div>
    <div id="body">${skeleton(8, 22)}</div>`;

  if (!backendEnabled()) {
    $('#body', el).innerHTML = '<div class="card empty"><h3>News is not configured</h3><p>This deployment has no backend, so the news collector is not running.</p></div>';
    return;
  }

  const rows = await getNews({ coin: coinParam ? coinParam.toUpperCase() : null, limit: 120 }).catch(() => []);
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  const coins = [...new Set(rows.flatMap((r) => r.coins || []))].sort();
  let source = 'all', coin = coinParam ? coinParam.toUpperCase() : 'all', q = '';

  const draw = () => {
    let list = rows;
    if (source !== 'all') list = list.filter((r) => r.source === source);
    if (coin !== 'all') list = list.filter((r) => (r.coins || []).includes(coin));
    if (q) list = list.filter((r) => `${r.title} ${r.summary || ''}`.toLowerCase().includes(q));
    $('#list', el).innerHTML = list.length ? list.map((r) => `
      <article class="news-item">
        ${r.image ? `<img src="${esc(r.image)}" alt="" width="92" height="64" loading="lazy" style="width:92px;height:64px;object-fit:cover;border-radius:10px;flex:none" data-fallback="remove">` : ''}
        <div style="min-width:0">
          <a class="ttl" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
          ${r.summary ? `<p class="fine" style="margin:4px 0 0">${esc(r.summary.slice(0, 200))}${r.summary.length > 200 ? '…' : ''}</p>` : ''}
          <div class="meta"><b>${esc(r.source)}</b><span>${ago(new Date(r.published_at).getTime())}</span>${(r.coins || []).slice(0, 5).map((c) => `<a href="#/coin/${esc(c)}" class="chip">${esc(c)}</a>`).join('')}</div>
        </div>
      </article>`).join('') : `<div class="empty">${icon('info', 20)}<p>No headlines match that filter.</p></div>`;
  };

  $('#body', el).innerHTML = `
    <div class="card">
      <div class="card-h">
        <div class="seg" id="src"><button data-v="all" class="on">All sources</button>${sources.map((s) => `<button data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <span class="fine">${rows.length} headlines</span>
      </div>
      ${coins.length ? `<div class="seg" id="cn" style="margin-bottom:10px"><button data-v="all" class="${coin === 'all' ? 'on' : ''}">Any coin</button>${coins.slice(0, 14).map((c) => `<button data-v="${esc(c)}" class="${coin === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>` : ''}
      <div class="news-list" id="list"></div>
    </div>
    <p class="fine mt">Headlines are collected automatically and shown unedited — ${esc('CoinVantage')} does not endorse or verify them. Always check the source before acting on a story.</p>`;

  bindSeg($('#src', el), (v) => { source = v; draw(); });
  if ($('#cn', el)) bindSeg($('#cn', el), (v) => { coin = v; draw(); });
  $('#q', el).addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  draw();
  void $$;
}
