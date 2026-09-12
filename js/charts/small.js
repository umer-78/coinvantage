// Small SVG/DOM charts: sparkline, donut, sentiment gauge, treemap heatmap.
import { esc } from '../format.js';

export function sparkline(values, { w = 120, h = 36, stroke } = {}) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 2) return `<svg width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const step = Math.max(1, Math.floor(v.length / 60));
  const pts = v.filter((_, i) => i % step === 0 || i === v.length - 1);
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((p - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join('');
  const color = stroke || (pts[pts.length - 1] >= pts[0] ? 'var(--up)' : 'var(--down)');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

export function donut(items, { size = 180, thickness = 26 } = {}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return '';
  const r = size / 2 - thickness / 2, c = size / 2, circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = items.map((it) => {
    const len = (it.value / total) * circ;
    const gap = items.length > 1 ? Math.min(2, len / 2) : 0;
    const el = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0, len - gap)} ${circ}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"><title>${esc(it.label)}: ${((it.value / total) * 100).toFixed(1)}%</title></circle>`;
    offset += len;
    return el;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Allocation">${arcs.join('')}</svg>`;
}

export function gauge(value, label) {
  const v = Math.max(0, Math.min(100, value ?? 50));
  const angle = Math.PI * (1 - v / 100);
  const cx = 100, cy = 96, r = 78;
  const nx = cx + r * Math.cos(angle), ny = cy - r * Math.sin(angle);
  const seg = (from, to, color) => {
    const a1 = Math.PI * (1 - from / 100), a2 = Math.PI * (1 - to / 100);
    return `<path d="M${cx + r * Math.cos(a1)},${cy - r * Math.sin(a1)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a2)},${cy - r * Math.sin(a2)}" stroke="${color}" stroke-width="12" fill="none" stroke-linecap="butt"/>`;
  };
  return `<svg viewBox="0 0 200 118" class="gauge" role="img" aria-label="Fear and Greed ${v}: ${esc(label)}">
    ${seg(0, 24.5, 'var(--down)')}${seg(25.5, 44.5, '#e8833a')}${seg(45.5, 55.5, 'var(--text-muted)')}${seg(56.5, 75.5, '#8fc93a')}${seg(76.5, 100, 'var(--up)')}
    <circle cx="${nx}" cy="${ny}" r="8" fill="var(--surface)" stroke="var(--text)" stroke-width="3"/>
    <text x="100" y="92" text-anchor="middle" class="g-val">${Math.round(v)}</text>
    <text x="100" y="112" text-anchor="middle" class="g-lbl">${esc(label)}</text></svg>`;
}

// Squarified treemap → absolutely positioned tiles
export function treemap(el, items, { onClick } = {}) {
  const W = el.clientWidth || 800, H = el.clientHeight || 480;
  const total = items.reduce((s, i) => s + i.value, 0);
  const nodes = items.map((i) => ({ ...i, area: (i.value / total) * W * H }));
  const rects = [];
  let x = 0, y = 0, w = W, h = H;
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, n) => a + n.area, 0);
    const mx = Math.max(...r.map((n) => n.area)), mn = Math.min(...r.map((n) => n.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layoutRow = (r) => {
    const s = r.reduce((a, n) => a + n.area, 0);
    if (w >= h) {
      const rw = s / h; let yy = y;
      for (const n of r) { const rh = n.area / rw; rects.push({ ...n, x, y: yy, w: rw, h: rh }); yy += rh; }
      x += rw; w -= rw;
    } else {
      const rh = s / w; let xx = x;
      for (const n of r) { const rw = n.area / rh; rects.push({ ...n, x: xx, y, w: rw, h: rh }); xx += rw; }
      y += rh; h -= rh;
    }
  };
  for (const node of nodes) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, node], side) <= worst(row, side)) row.push(node);
    else { layoutRow(row); row = [node]; }
  }
  if (row.length) layoutRow(row);
  el.innerHTML = rects.map((r, i) => {
    const big = r.w > 90 && r.h > 50;
    const show = r.w > 44 && r.h > 26;
    return `<button class="tm-tile" data-i="${i}" style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w - 2)}px;height:${Math.max(0, r.h - 2)}px;background:${r.color}" title="${esc(r.label)} ${esc(r.sub)}">
      ${show ? `<span class="tm-sym" style="font-size:${big ? Math.min(22, 10 + r.w / 18) : 11}px">${esc(r.label)}</span><span class="tm-sub">${esc(r.sub)}</span>` : ''}</button>`;
  }).join('');
  if (onClick) el.querySelectorAll('.tm-tile').forEach((b) => b.addEventListener('click', () => onClick(rects[+b.dataset.i])));
}

// Diverging color for % change: red ← neutral → green
export function changeColor(pctChange) {
  const v = Math.max(-10, Math.min(10, pctChange || 0)) / 10;
  if (Math.abs(v) < 0.02) return 'var(--tm-flat)';
  const a = 0.25 + Math.abs(v) * 0.75;
  return v > 0 ? `rgba(22, 199, 132, ${a})` : `rgba(234, 57, 67, ${a})`;
}
