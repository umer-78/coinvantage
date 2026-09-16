import { esc } from './format.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  markets: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  scanner: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6M11 8v6"/>',
  compare: '<path d="M3 17l5-5 4 3 5-7 4 3"/><path d="M3 21h18" opacity=".5"/>',
  exchanges: '<path d="M7 7h13l-3-3"/><path d="M17 17H4l3 3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="15" r="1.3"/>',
  alerts: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  ai: '<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  forecast: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/>',
};
export const icon = (name, size = 18) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export function coinLogo(coin, size = 24) {
  const letter = esc((coin?.symbol || '?').slice(0, 1));
  if (!coin?.image) return `<span class="logo logo-fb" style="width:${size}px;height:${size}px;font-size:${size * 0.45}px">${letter}</span>`;
  return `<img class="logo" src="${esc(coin.image)}" width="${size}" height="${size}" alt="" loading="lazy" data-letter="${letter}">`;
}

// The page's Content-Security-Policy has no 'unsafe-inline' for scripts, so an
// onerror="" attribute never runs — every logo that 404s used to be left as a
// browser broken-image glyph. `error` does not bubble, so this listens in the
// capture phase instead, once, for the whole app.
if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    if (t.dataset.fallback === 'remove') { t.remove(); return; }
    if (t.classList.contains('logo') && t.dataset.letter) {
      const size = Number(t.getAttribute('width')) || 24;
      const span = document.createElement('span');
      span.className = 'logo logo-fb';
      span.style.cssText = `width:${size}px;height:${size}px;font-size:${size * 0.45}px`;
      span.textContent = t.dataset.letter;
      t.replaceWith(span);
    }
  }, true);
}

export function toast(msg, toneName = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.append(host); }
  const t = document.createElement('div');
  t.className = `toast ${toneName}`;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export const skeleton = (rows = 6, h = 18) => `<div class="skel-wrap">${Array.from({ length: rows }, () => `<div class="skel" style="height:${h}px"></div>`).join('')}</div>`;

export function errorBox(msg, retry) {
  const id = `r${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => { const b = document.getElementById(id); if (b && retry) b.onclick = retry; });
  return `<div class="empty"><p>${esc(msg)}</p>${retry ? `<button class="btn" id="${id}">${icon('refresh', 16)} Try again</button>` : ''}</div>`;
}

// Tabs: <div class="tabs" data-tabs> <button data-tab="x">
export function bindTabs(root, onChange) {
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => {
    $$('[data-tab]', root).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    onChange(b.dataset.tab);
  }));
}

// Segmented control: <div class="seg"> <button data-v="1h">
export function bindSeg(root, onChange) {
  $$('button[data-v]', root).forEach((b) => b.addEventListener('click', () => {
    $$('button[data-v]', root).forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  }));
}

// Minimal safe markdown → HTML (escape first, then format)
export function markdown(src) {
  const lines = esc(src || '').replace(/<think>[\s\S]*?<\/think>/g, '').split('\n');
  const out = [];
  let list = null;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^#{1,4}\s+(.*)/.exec(line))) {
      closeList(); out.push(`<h4>${inline(m[1])}</h4>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList(); out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

export function modal(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="icon-btn modal-x" aria-label="Close">${icon('close')}</button>${html}</div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { el: wrap.querySelector('.modal'), close };
}
