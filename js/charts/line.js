// Multi-series line chart on canvas with shaded bands, a "now" divider,
// crosshair tooltip and legend. Used for comparisons, pattern overlays,
// forecasts and equity curves.
import { niceTicks } from './candles.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class LineChart {
  constructor(el, { yFormat = (v) => v.toFixed(2), xFormat = (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), tooltipX = null, height = 280, legend = true, zeroLine = null } = {}) {
    this.el = el;
    this.o = { yFormat, xFormat, tooltipX: tooltipX || xFormat, legend, zeroLine };
    el.classList.add('lc-root');
    el.style.height = `${height}px`;
    this.legendEl = document.createElement('div');
    this.legendEl.className = 'lc-legend';
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'lc-tip';
    this.tip.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'lc-wrap';
    wrap.append(this.canvas, this.tip);
    if (legend) el.append(this.legendEl);
    el.append(wrap);
    this.wrap = wrap;
    this.ctx = this.canvas.getContext('2d');
    this.series = []; this.bands = []; this.divider = null;
    this.canvas.addEventListener('pointermove', (e) => { this.hover = e.offsetX; this.draw(); });
    this.canvas.addEventListener('pointerdown', (e) => { this.hover = e.offsetX; this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
  }

  destroy() { this.ro.disconnect(); }

  // series: [{ name, color, data: [{x, y}], width, dash, alpha, hideLegend }]
  // bands:  [{ color, alpha, data: [{x, lo, hi}] }]
  set(series, { bands = [], divider = null, dividerLabel = '' } = {}) {
    this.series = series; this.bands = bands; this.divider = divider; this.dividerLabel = dividerLabel;
    if (this.o.legend) {
      this.legendEl.innerHTML = series.filter((s) => !s.hideLegend).map((s) =>
        `<span class="lg"><i style="background:${s.color};${s.dash ? 'height:0;border-top:2px dashed ' + s.color + ';background:none' : ''}"></i>${s.name}</span>`).join('');
    }
    this.draw();
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(160, r.width); this.h = Math.max(120, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const { ctx } = this;
    if (!ctx || !this.w) return;
    const col = { grid: css('--chart-grid'), text: css('--text-muted'), ink: css('--text'), bg: css('--chart-bg') };
    ctx.clearRect(0, 0, this.w, this.h);
    const all = this.series.flatMap((s) => s.data);
    if (!all.length) return;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const p of all) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); if (Number.isFinite(p.y)) { ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); } }
    for (const b of this.bands) for (const p of b.data) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); ymin = Math.min(ymin, p.lo); ymax = Math.max(ymax, p.hi); }
    if (this.o.zeroLine !== null) { ymin = Math.min(ymin, this.o.zeroLine); ymax = Math.max(ymax, this.o.zeroLine); }
    const pad = (ymax - ymin) * 0.08 || Math.abs(ymax) * 0.02 || 1;
    ymin -= pad; ymax += pad;
    const axisW = 58, left = 6, top = 10, bottom = this.h - 22;
    const plotR = this.w - axisW;
    const X = (x) => left + ((x - xmin) / (xmax - xmin || 1)) * (plotR - left - 6);
    const Y = (y) => top + ((ymax - y) / (ymax - ymin)) * (bottom - top);

    ctx.strokeStyle = col.grid; ctx.lineWidth = 1; ctx.fillStyle = col.text; ctx.font = '11px system-ui'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const ticks = niceTicks(ymin, ymax, Math.max(3, Math.floor(this.h / 60)));
    ctx.beginPath();
    for (const t of ticks) { const yy = Math.round(Y(t)) + 0.5; ctx.moveTo(left, yy); ctx.lineTo(plotR, yy); }
    ctx.stroke();
    for (const t of ticks) ctx.fillText(this.o.yFormat(t), plotR + 6, Y(t));
    if (this.o.zeroLine !== null) {
      ctx.strokeStyle = col.text; ctx.globalAlpha = 0.5; ctx.beginPath();
      ctx.moveTo(left, Math.round(Y(this.o.zeroLine)) + 0.5); ctx.lineTo(plotR, Math.round(Y(this.o.zeroLine)) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    }
    // x labels
    ctx.textAlign = 'center';
    const xt = 5;
    for (let k = 0; k <= xt; k++) {
      const xv = xmin + ((xmax - xmin) * k) / xt;
      ctx.fillText(this.o.xFormat(xv), Math.min(plotR - 24, Math.max(24, X(xv))), this.h - 10);
    }
    // divider
    if (this.divider !== null) {
      const dx = Math.round(X(this.divider)) + 0.5;
      ctx.strokeStyle = col.text; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(dx, top); ctx.lineTo(dx, bottom); ctx.stroke(); ctx.setLineDash([]);
      if (this.dividerLabel) { ctx.fillStyle = col.text; ctx.textAlign = 'left'; ctx.font = '600 10px system-ui'; ctx.fillText(this.dividerLabel, dx + 5, top + 6); }
    }
    // bands
    for (const b of this.bands) {
      if (!b.data.length) continue;
      ctx.beginPath();
      b.data.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.hi)) : ctx.moveTo(X(p.x), Y(p.hi))));
      for (let i = b.data.length - 1; i >= 0; i--) ctx.lineTo(X(b.data[i].x), Y(b.data[i].lo));
      ctx.closePath(); ctx.fillStyle = b.color; ctx.globalAlpha = b.alpha ?? 0.15; ctx.fill(); ctx.globalAlpha = 1;
    }
    // lines
    for (const s of this.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.globalAlpha = s.alpha ?? 1;
      ctx.setLineDash(s.dash ? [5, 4] : []);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const p of s.data) {
        if (!Number.isFinite(p.y)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(p.x), Y(p.y)); started = true; } else ctx.lineTo(X(p.x), Y(p.y));
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
    // hover
    if (this.hover !== null && this.hover !== undefined && this.hover <= plotR) {
      const xv = xmin + ((this.hover - left) / (plotR - left - 6)) * (xmax - xmin);
      const hx = Math.round(this.hover) + 0.5;
      ctx.strokeStyle = col.text; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(hx, top); ctx.lineTo(hx, bottom); ctx.stroke(); ctx.globalAlpha = 1;
      const rows = [];
      for (const s of this.series) {
        if (s.hideTooltip) continue;
        let best = null;
        for (const p of s.data) if (Number.isFinite(p.y) && (!best || Math.abs(p.x - xv) < Math.abs(best.x - xv))) best = p;
        if (!best || Math.abs(X(best.x) - this.hover) > 30) continue;
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(best.x), Y(best.y), 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col.bg; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
        rows.push(`<div><i style="background:${s.color}"></i>${s.name}<b>${this.o.yFormat(best.y)}</b></div>`);
      }
      if (rows.length) {
        this.tip.hidden = false;
        this.tip.innerHTML = `<div class="tt">${this.o.tooltipX(xv)}</div>${rows.join('')}`;
        const tw = this.tip.offsetWidth;
        this.tip.style.left = `${this.hover + 14 + tw > this.w ? this.hover - tw - 14 : this.hover + 14}px`;
        this.tip.style.top = '8px';
      } else this.tip.hidden = true;
    } else this.tip.hidden = true;
  }
}
