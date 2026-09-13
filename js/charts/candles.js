// Canvas candlestick chart: zoom/pan (mouse, wheel, touch pinch), crosshair,
// EMA / Bollinger overlays, volume, RSI & MACD panes, levels, markers, and an
// optional AI forecast cone drawn to the right of the last candle.
import { computeAll } from '../lib/indicators.js';
import { FIB_LEVELS, distToSegment } from '../lib/geometry.js';
// money() converts to the visitor's display currency; the chart's own scale stays in USD.
import { money as fmtPrice, compact } from '../format.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class CandleChart {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = { ema20: true, ema50: true, ema200: true, bb: false, vwap: false, ichimoku: false, volume: true, rsi: true, macd: false, levels: true, markers: true, projection: true, ...opts };
    this.candles = [];
    this.ind = null;
    this.levels = [];
    this.markers = [];
    this.projection = null;
    // Drawings are stored in TIME and PRICE, never pixels, so a trend line drawn
    // at one zoom level still touches the same two candles at another.
    this.drawings = [];
    this.tool = null;          // null = pan/zoom as usual
    this.pending = null;       // first point of a shape being drawn
    this.onDrawingsChange = null;
    this.barW = 8;
    this.offset = 0; // bars scrolled back from the latest
    this.hover = null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cc-canvas';
    this.legend = document.createElement('div');
    this.legend.className = 'cc-legend';
    el.classList.add('cc-root');
    el.append(this.canvas, this.legend);
    this.ctx = this.canvas.getContext('2d');
    this.pointers = new Map();
    this.bind();
    this.onCurrency = () => this.draw();
    window.addEventListener('cv:currency', this.onCurrency);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
  }

  destroy() { this.ro.disconnect(); window.removeEventListener('cv:currency', this.onCurrency); this.el.innerHTML = ''; }

  setData(candles, { keepView = false } = {}) {
    this.candles = candles;
    this.ind = candles.length ? computeAll(candles) : null;
    if (!keepView) { this.offset = 0; this.fitDefault(); }
    this.draw();
  }

  // Live update: replace the last candle or append a new one.
  update(c) {
    const n = this.candles.length;
    if (!n) return;
    const last = this.candles[n - 1];
    if (c.t === last.t) this.candles[n - 1] = c;
    else if (c.t > last.t) { this.candles.push(c); if (this.offset > 0) this.offset++; }
    else return;
    this.ind = computeAll(this.candles);
    this.schedule();
  }

  setOptions(patch) {
    Object.assign(this.opts, patch);
    if ('projection' in patch && this.offset < 0) this.offset = patch.projection && this.projection ? -(this.projection.length + 3) : 0;
    this.draw();
  }
  setLevels(levels) { this.levels = levels || []; this.draw(); }

  /** Replace every drawing on the chart. Shapes are {type, pts:[{t,p}], color?}. */
  setDrawings(list) { this.drawings = Array.isArray(list) ? list : []; this.pending = null; this.draw(); }

  /** 'trend' | 'hline' | 'fib' | 'erase' | null (null restores pan/zoom). */
  setTool(tool) {
    this.tool = tool || null;
    this.pending = null;
    this.canvas.style.cursor = this.tool ? (this.tool === 'erase' ? 'not-allowed' : 'crosshair') : '';
    this.draw();
  }

  clearDrawings() { this.drawings = []; this.pending = null; this.emitDrawings(); this.draw(); }

  emitDrawings() { this.onDrawingsChange?.(this.drawings); }

  /** pixel x → fractional candle index, the inverse of xOf(). */
  iOf(px) {
    const rightIndex = this.candles.length - 1 - this.offset;
    return rightIndex - (this.plotW - px - this.barW / 2 - 6) / this.barW;
  }

  /** pixel → a {t, p} anchor, interpolating time past the last candle. */
  anchorAt(px, py) {
    const n = this.candles.length;
    if (!n || !this.yInv) return null;
    const i = this.iOf(px);
    const step = n > 1 ? this.candles[n - 1].t - this.candles[n - 2].t : 36e5;
    const clamped = Math.max(0, Math.min(n - 1, i));
    const base = this.candles[Math.round(clamped)].t;
    const t = i > n - 1 ? this.candles[n - 1].t + (i - (n - 1)) * step
      : i < 0 ? this.candles[0].t + i * step
        : base;
    return { t, p: this.yInv(py) };
  }

  /** {t,p} → pixels, for drawing. */
  pointPx(pt, y) {
    const n = this.candles.length;
    if (!n) return null;
    const step = n > 1 ? this.candles[n - 1].t - this.candles[n - 2].t : 36e5;
    // nearest candle by time, extrapolating either side
    let i;
    if (pt.t <= this.candles[0].t) i = (pt.t - this.candles[0].t) / step;
    else if (pt.t >= this.candles[n - 1].t) i = n - 1 + (pt.t - this.candles[n - 1].t) / step;
    else {
      i = 0;
      let best = Infinity;
      for (let k = 0; k < n; k++) { const d = Math.abs(this.candles[k].t - pt.t); if (d < best) { best = d; i = k; } }
    }
    return { x: this.xOf(i), y: y(pt.p) };
  }
  setMarkers(markers) { this.markers = markers || []; this.draw(); }
  setProjection(p) {
    this.projection = p;
    // make room on the right for the forecast cone unless the user has scrolled back
    if (p?.length && this.opts.projection && this.offset <= 0) this.offset = -(p.length + 3);
    this.draw();
  }

  fitDefault() {
    const w = this.plotW || 600;
    this.barW = Math.max(3, Math.min(14, w / 110));
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.draw(); });
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(200, r.width);
    this.h = Math.max(220, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ----------------------------------------------------------- interaction
  bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.pan(e.deltaX / this.barW); return; }
      this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      // With a tool selected the gesture draws instead of panning.
      if (this.tool) { this.toolDown(e); return; }
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, startX: e.offsetX, moved: false });
      if (this.pointers.size === 2) this.pinchDist = this.pointerDistance();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.tool) {
        this.hover = { x: e.offsetX, y: e.offsetY };
        this.schedule();
        return;
      }
      const p = this.pointers.get(e.pointerId);
      if (p) {
        if (this.pointers.size === 2) {
          p.x = e.offsetX; p.y = e.offsetY;
          const d = this.pointerDistance();
          if (this.pinchDist) this.zoom(d / this.pinchDist, this.plotW);
          this.pinchDist = d;
          return;
        }
        const dx = e.offsetX - p.x;
        if (Math.abs(e.offsetX - p.startX) > 4) p.moved = true;
        p.x = e.offsetX; p.y = e.offsetY;
        if (p.moved) { this.pan(-dx / this.barW); if (e.pointerType !== 'mouse') { this.hover = null; return; } }
      }
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.schedule();
    });
    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = null;
      if (p && !p.moved && e.pointerType !== 'mouse') { this.hover = { x: e.offsetX, y: e.offsetY }; this.schedule(); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.hover = null; this.schedule(); } });
    c.addEventListener('dblclick', () => { this.offset = this.projection && this.opts.projection ? -(this.projection.length + 3) : 0; this.fitDefault(); this.draw(); });
  }

  // --- drawing tools ---------------------------------------------------
  //
  // One tap places a horizontal line; two taps define a trend line or a
  // Fibonacci retracement. Keeping it to taps (rather than click-and-drag)
  // means the same code works with a finger on a phone.
  toolDown(e) {
    const a = this.anchorAt(e.offsetX, e.offsetY);
    if (!a) return;

    if (this.tool === 'erase') {
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit >= 0) { this.drawings.splice(hit, 1); this.emitDrawings(); }
      this.draw();
      return;
    }

    if (this.tool === 'hline') {
      this.drawings.push({ type: 'hline', pts: [a] });
      this.emitDrawings();
      this.draw();
      return;
    }

    if (!this.pending) { this.pending = a; this.draw(); return; }
    this.drawings.push({ type: this.tool, pts: [this.pending, a] });
    this.pending = null;
    this.emitDrawings();
    this.draw();
  }

  /** Index of the drawing under the pointer, or -1. */
  hitTest(px, py) {
    if (!this.lastGeom) return -1;
    const { y } = this.lastGeom;
    const near = 8;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.type === 'hline') {
        if (Math.abs(y(d.pts[0].p) - py) <= near) return i;
        continue;
      }
      const a = this.pointPx(d.pts[0], y), b = this.pointPx(d.pts[1], y);
      if (!a || !b) continue;
      if (d.type === 'fib') {
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        for (const r of FIB_LEVELS) {
          const yy = hi - (hi - lo) * r;
          if (Math.abs(yy - py) <= near && px >= Math.min(a.x, b.x) - 20 && px <= Math.max(a.x, b.x) + 400) return i;
        }
        continue;
      }
      if (distToSegment(px, py, a.x, a.y, b.x, b.y) <= near) return i;
    }
    return -1;
  }

  drawDrawings(y, col) {
    const { ctx } = this;
    const accent = col.accent;
    ctx.save();
    ctx.lineWidth = 1.6;

    const drawOne = (d, ghost = false) => {
      ctx.globalAlpha = ghost ? 0.55 : 1;
      ctx.strokeStyle = d.color || accent;
      if (d.type === 'hline') {
        const yy = Math.round(y(d.pts[0].p)) + 0.5;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(this.plotW, yy); ctx.stroke();
        label(this.plotW - 4, yy, fmtPrice(d.pts[0].p), 'right');
        return;
      }
      const a = this.pointPx(d.pts[0], y), b = this.pointPx(d.pts[1], y);
      if (!a || !b) return;
      if (d.type === 'trend') {
        ctx.setLineDash([]);
        // extend the line to the right edge so it keeps projecting forward
        const dx = b.x - a.x;
        const slope = dx === 0 ? 0 : (b.y - a.y) / dx;
        const endX = this.plotW;
        const endY = b.y + slope * (endX - b.x);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.globalAlpha = (ghost ? 0.55 : 1) * 0.45;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(endX, endY); ctx.stroke();
        ctx.setLineDash([]);
        if (!ghost) { dot(a.x, a.y); dot(b.x, b.y); }
        return;
      }
      if (d.type === 'fib') {
        const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
        const hiP = Math.max(d.pts[0].p, d.pts[1].p), loP = Math.min(d.pts[0].p, d.pts[1].p);
        const left = Math.min(a.x, b.x);
        ctx.setLineDash([]);
        for (const r of FIB_LEVELS) {
          const yy = Math.round(bottom - (bottom - top) * r) + 0.5;
          ctx.globalAlpha = (ghost ? 0.55 : 1) * (r === 0 || r === 1 ? 0.9 : 0.6);
          ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(this.plotW, yy); ctx.stroke();
          const price = loP + (hiP - loP) * r;
          label(left + 4, yy, `${(r * 100).toFixed(1)}%  ${fmtPrice(price)}`, 'left');
        }
        ctx.globalAlpha = ghost ? 0.55 : 1;
        if (!ghost) { dot(a.x, a.y); dot(b.x, b.y); }
      }
    };

    const dot = (x, yy) => {
      ctx.save();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(x, yy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    const label = (x, yy, text, align) => {
      ctx.save();
      ctx.font = '10px system-ui';
      ctx.textAlign = align;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = 0.95;
      ctx.fillText(text, x, yy - 2);
      ctx.restore();
    };

    for (const d of this.drawings) drawOne(d);

    // the shape being placed, following the pointer
    if (this.pending && this.hover && this.tool && this.tool !== 'hline' && this.tool !== 'erase') {
      const live = this.anchorAt(this.hover.x, this.hover.y);
      if (live) drawOne({ type: this.tool, pts: [this.pending, live] }, true);
    }
    ctx.restore();
  }

  pointerDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  zoom(factor, anchorX) {
    const old = this.barW;
    this.barW = Math.max(1.5, Math.min(40, this.barW * factor));
    // keep the bar under the anchor roughly in place
    const fromRight = (this.plotW - anchorX) / old;
    this.offset += fromRight - (this.plotW - anchorX) / this.barW;
    this.clampOffset();
    this.schedule();
  }

  pan(bars) {
    this.offset -= bars;
    this.clampOffset();
    this.schedule();
  }

  clampOffset() {
    const n = this.candles.length;
    const visible = this.plotW / this.barW;
    const future = this.projection && this.opts.projection ? this.projection.length + 2 : 4;
    this.offset = Math.max(-future, Math.min(n - visible * 0.3, this.offset));
  }

  // ----------------------------------------------------------- drawing
  layout() {
    const axisW = this.w < 480 ? 56 : 68;
    const timeH = 20;
    const panes = [];
    const subs = [this.opts.rsi && 'rsi', this.opts.macd && 'macd'].filter(Boolean);
    const subH = subs.length ? Math.max(56, Math.min(110, this.h * 0.17)) : 0;
    const mainH = this.h - timeH - subH * subs.length;
    panes.push({ key: 'main', top: 0, h: mainH });
    subs.forEach((k, i) => panes.push({ key: k, top: mainH + subH * i, h: subH }));
    this.plotW = this.w - axisW;
    return { axisW, timeH, panes, mainH };
  }

  xOf(i) {
    // index i (0..n-1, fractional allowed) → pixel center
    const n = this.candles.length;
    const rightIndex = n - 1 - this.offset; // index at the right edge (center of last visible bar)
    return this.plotW - (rightIndex - i) * this.barW - this.barW / 2 - 6;
  }

  draw() {
    const { ctx, candles } = this;
    if (!ctx) return;
    const L = this.layout();
    const col = {
      bg: css('--chart-bg') || '#0b0f17', grid: css('--chart-grid') || '#1b2230', text: css('--text-muted') || '#8a93a6',
      up: css('--up') || '#16c784', down: css('--down') || '#ea3943', ink: css('--text') || '#e6e9ef',
      ema20: css('--series-1') || '#3987e5', ema50: css('--series-2') || '#d95926', ema200: css('--series-7') || '#9085e9',
      accent: css('--accent') || '#f0b90b', band: css('--band') || 'rgba(57,135,229,.12)',
    };
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!candles.length) {
      ctx.fillStyle = col.text; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Loading chart…', this.w / 2, this.h / 2);
      return;
    }
    this.clampOffset();
    const n = candles.length;
    const first = Math.max(0, Math.floor(n - 1 - this.offset - this.plotW / this.barW) - 1);
    const last = Math.min(n - 1, Math.ceil(n - 1 - this.offset) + 1);
    const ind = this.ind;
    const main = L.panes[0];
    const volH = this.opts.volume ? main.h * 0.18 : 0;
    const priceTop = 10, priceBottom = main.h - 8 - volH;

    // y-range from visible data (+ overlays, + projection)
    let lo = Infinity, hi = -Infinity;
    for (let i = first; i <= last; i++) { lo = Math.min(lo, candles[i].l); hi = Math.max(hi, candles[i].h); }
    const inc = (arr) => { for (let i = first; i <= last; i++) { const v = arr?.[i]; if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } };
    if (this.opts.bb) { inc(ind.bb.upper); inc(ind.bb.lower); }
    if (this.opts.vwap) inc(ind.vwap);
    if (this.opts.ichimoku) { inc(ind.ichimoku.senkouA); inc(ind.ichimoku.senkouB); inc(ind.ichimoku.tenkan); inc(ind.ichimoku.kijun); }
    const proj = this.opts.projection && this.projection?.length ? this.projection : null;
    if (proj && this.offset < proj.length + 2) for (const p of proj) { lo = Math.min(lo, p.p10); hi = Math.max(hi, p.p90); }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    const y = (v) => priceTop + ((hi - v) / (hi - lo)) * (priceBottom - priceTop);
    this.yInv = (py) => hi - ((py - priceTop) / (priceBottom - priceTop)) * (hi - lo);
    this.scale = { lo, hi, first, last };
    this.lastGeom = { y, priceTop, priceBottom };

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.plotW, this.h - L.timeH); ctx.clip();

    // grid
    ctx.strokeStyle = col.grid; ctx.lineWidth = 1;
    const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(main.h / 60)));
    ctx.beginPath();
    for (const t of ticks) { const yy = Math.round(y(t)) + 0.5; ctx.moveTo(0, yy); ctx.lineTo(this.plotW, yy); }
    ctx.stroke();

    // Bollinger band
    if (this.opts.bb) {
      ctx.fillStyle = col.band;
      ctx.beginPath();
      let started = false;
      for (let i = first; i <= last; i++) { const v = ind.bb.upper[i]; if (v === null) continue; const X = this.xOf(i); if (!started) { ctx.moveTo(X, y(v)); started = true; } else ctx.lineTo(X, y(v)); }
      for (let i = last; i >= first; i--) { const v = ind.bb.lower[i]; if (v === null) continue; ctx.lineTo(this.xOf(i), y(v)); }
      ctx.closePath(); ctx.fill();
      this.line(ind.bb.upper, first, last, y, col.ema20, 1, 0.5);
      this.line(ind.bb.lower, first, last, y, col.ema20, 1, 0.5);
    }

    // volume
    if (this.opts.volume) {
      let vmax = 0;
      for (let i = first; i <= last; i++) vmax = Math.max(vmax, candles[i].v);
      if (vmax > 0) {
        const base = main.h - 4;
        for (let i = first; i <= last; i++) {
          const c = candles[i];
          const vh = (c.v / vmax) * (volH - 4);
          ctx.fillStyle = c.c >= c.o ? col.up : col.down;
          ctx.globalAlpha = 0.28;
          const bw = Math.max(1, this.barW * 0.7);
          ctx.fillRect(this.xOf(i) - bw / 2, base - vh, bw, vh);
        }
        ctx.globalAlpha = 1;
      }
    }

    // candles
    const bodyW = Math.max(1, this.barW * 0.68);
    for (let i = first; i <= last; i++) {
      const c = candles[i];
      const X = Math.round(this.xOf(i)) + 0.5;
      const upC = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = upC ? col.up : col.down;
      ctx.beginPath(); ctx.moveTo(X, y(c.h)); ctx.lineTo(X, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillRect(X - bodyW / 2, top, bodyW, Math.max(1, bot - top));
    }

    // EMAs
    // Ichimoku goes under the moving averages: it is a background of trend,
    // not a line to read a level off.
    if (this.opts.ichimoku) this.drawCloud(ind.ichimoku, first, last, y, col);
    if (this.opts.vwap) this.line(ind.vwap, first, last, y, css('--series-4') || '#e0507a', 1.8);
    if (this.opts.ema20) this.line(ind.ema20, first, last, y, col.ema20, 1.5);
    if (this.opts.ema50) this.line(ind.ema50, first, last, y, col.ema50, 1.5);
    if (this.opts.ema200) this.line(ind.ema200, first, last, y, col.ema200, 1.5);

    // AI forecast cone
    if (proj) {
      const x0 = this.xOf(n - 1), p0 = candles[n - 1].c;
      const band = (loK, hiK, alpha) => {
        ctx.beginPath(); ctx.moveTo(x0, y(p0));
        proj.forEach((p, k) => ctx.lineTo(this.xOf(n + k), y(p[hiK])));
        for (let k = proj.length - 1; k >= 0; k--) ctx.lineTo(this.xOf(n + k), y(proj[k][loK]));
        ctx.closePath(); ctx.globalAlpha = alpha; ctx.fillStyle = col.accent; ctx.fill(); ctx.globalAlpha = 1;
      };
      band('p10', 'p90', 0.1); band('p25', 'p75', 0.18);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = col.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y(p0)); proj.forEach((p, k) => ctx.lineTo(this.xOf(n + k), y(p.p50))); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
    }

    // markers
    if (this.opts.markers) {
      for (const m of this.markers) {
        const i = m.index ?? bsearch(candles, m.t);
        if (i < first || i > last) continue;
        const X = this.xOf(i), c = candles[i];
        const buy = m.side === 'buy';
        const yy = buy ? y(c.l) + 12 : y(c.h) - 12;
        ctx.fillStyle = buy ? col.up : col.down;
        ctx.beginPath();
        if (buy) { ctx.moveTo(X, yy - 7); ctx.lineTo(X - 5, yy + 2); ctx.lineTo(X + 5, yy + 2); }
        else { ctx.moveTo(X, yy + 7); ctx.lineTo(X - 5, yy - 2); ctx.lineTo(X + 5, yy - 2); }
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();

    // the reader's own trend lines, Fibonacci levels and horizontals — drawn
    // above the market data, below the crosshair
    this.drawDrawings(y, col);

    // levels (drawn across plot, label on axis)
    const tags = [];
    if (this.opts.levels) {
      const usedY = [];
      for (let lv of [...this.levels].sort((a, b) => (b.label ? 1 : 0) - (a.label ? 1 : 0))) {
        if (lv.price < lo || lv.price > hi) continue;
        const yy = Math.round(y(lv.price)) + 0.5;
        const crowded = usedY.some((u) => Math.abs(u - yy) < 14);
        usedY.push(yy);
        if (crowded) lv = { ...lv, label: '' };
        ctx.strokeStyle = lv.color || col.text; ctx.globalAlpha = 0.85; ctx.setLineDash(lv.dash === false ? [] : [4, 4]);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(this.plotW, yy); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (lv.label) {
          ctx.font = '600 10px system-ui'; ctx.fillStyle = lv.color || col.text; ctx.textAlign = 'left';
          ctx.fillText(lv.label, 6, yy - 4);
        }
        if (!crowded) tags.push({ y: yy, text: fmtPrice(lv.price), color: lv.color || col.text });
      }
    }

    // price axis
    ctx.fillStyle = col.bg; ctx.fillRect(this.plotW, 0, L.axisW, this.h);
    ctx.fillStyle = col.text; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const t of ticks) ctx.fillText(fmtPrice(t), this.plotW + 6, y(t));
    const lastC = candles[n - 1];
    tags.push({ y: y(lastC.c), text: fmtPrice(lastC.c), color: lastC.c >= lastC.o ? col.up : col.down, solid: true });
    const lastTagY = y(lastC.c);
    for (const tg of tags) {
      if (tg.y < 0 || tg.y > main.h) continue;
      if (!tg.solid && Math.abs(tg.y - lastTagY) < 18) continue;
      ctx.fillStyle = tg.color; ctx.fillRect(this.plotW + 1, tg.y - 9, L.axisW - 2, 18);
      ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui'; ctx.fillText(tg.text, this.plotW + 5, tg.y);
    }
    if (lastC && this.offset <= 0.5) {
      ctx.strokeStyle = lastC.c >= lastC.o ? col.up : col.down; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(y(lastC.c)) + 0.5); ctx.lineTo(this.plotW, Math.round(y(lastC.c)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    }

    // sub panes
    for (const pane of L.panes.slice(1)) this.drawSub(pane, first, last, col);

    // time axis
    const ty = this.h - L.timeH;
    ctx.fillStyle = col.bg; ctx.fillRect(0, ty, this.w, L.timeH);
    ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(0, ty + 0.5); ctx.lineTo(this.w, ty + 0.5); ctx.stroke();
    ctx.fillStyle = col.text; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const step = Math.max(1, Math.ceil(90 / this.barW));
    const spanMs = n > 1 ? candles[n - 1].t - candles[n - 2].t : 36e5;
    for (let i = Math.ceil(first / step) * step; i <= last; i += step) {
      const X = this.xOf(i);
      if (X < 20 || X > this.plotW - 20) continue;
      ctx.fillText(timeLabel(candles[i].t, spanMs), X, ty + L.timeH / 2);
    }

    this.drawHover(L, col, y);
  }

  // The cloud is the point of Ichimoku: a shaded band between the two spans,
  // pushed 26 bars into the future, green when the faster span is on top.
  drawCloud(ich, first, last, y, col) {
    const { ctx } = this;
    const end = Math.min(ich.senkouA.length - 1, last + ich.displacement);
    ctx.save();
    for (let i = Math.max(first, 1); i <= end; i++) {
      const a0 = ich.senkouA[i - 1], b0 = ich.senkouB[i - 1];
      const a1 = ich.senkouA[i], b1 = ich.senkouB[i];
      if (a0 === null || b0 === null || a1 === null || b1 === null) continue;
      const x0 = this.xOf(i - 1), x1 = this.xOf(i);
      if (x1 < -20 || x0 > this.plotW + 20) continue;
      ctx.fillStyle = a1 >= b1 ? col.up : col.down;
      ctx.globalAlpha = 0.13;
      ctx.beginPath();
      ctx.moveTo(x0, y(a0)); ctx.lineTo(x1, y(a1)); ctx.lineTo(x1, y(b1)); ctx.lineTo(x0, y(b0));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    this.line(ich.senkouA, first, end, y, col.up, 1, 0.45);
    this.line(ich.senkouB, first, end, y, col.down, 1, 0.45);
    this.line(ich.tenkan, first, last, y, col.ema20, 1.2, 0.85);
    this.line(ich.kijun, first, last, y, col.ema50, 1.2, 0.85);
  }

  line(arr, first, last, y, color, width = 1.5, alpha = 1, yMap = y) {
    const { ctx } = this;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    ctx.beginPath();
    let started = false;
    for (let i = first; i <= last; i++) {
      const v = arr[i];
      if (v === null || v === undefined) { started = false; continue; }
      const X = this.xOf(i), Y = yMap(v);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    }
    ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
  }

  drawSub(pane, first, last, col) {
    const { ctx, ind } = this;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, pane.top, this.w, pane.h); ctx.clip();
    ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(0, pane.top + 0.5); ctx.lineTo(this.w, pane.top + 0.5); ctx.stroke();
    const top = pane.top + 14, bottom = pane.top + pane.h - 4;
    ctx.fillStyle = col.text; ctx.font = '600 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if (pane.key === 'rsi') {
      const y = (v) => top + ((100 - v) / 100) * (bottom - top);
      ctx.strokeStyle = col.grid; ctx.setLineDash([3, 3]);
      ctx.beginPath(); [30, 70].forEach((g) => { ctx.moveTo(0, Math.round(y(g)) + 0.5); ctx.lineTo(this.plotW, Math.round(y(g)) + 0.5); }); ctx.stroke(); ctx.setLineDash([]);
      this.line(ind.rsi, first, last, y, col.ema200, 1.5);
      const r = ind.rsi[this.hoverIndex ?? this.candles.length - 1];
      ctx.fillStyle = col.text; ctx.fillText(`RSI 14  ${r !== null && r !== undefined ? r.toFixed(1) : ''}`, 6, pane.top + 11);
      ctx.textBaseline = 'middle'; ['70', '30'].forEach((g) => ctx.fillText(g, this.plotW + 6, y(+g)));
    } else if (pane.key === 'macd') {
      let m = 0;
      for (let i = first; i <= last; i++) m = Math.max(m, Math.abs(ind.macd.line[i] ?? 0), Math.abs(ind.macd.signal[i] ?? 0), Math.abs(ind.macd.hist[i] ?? 0));
      m = m || 1;
      const mid = (top + bottom) / 2;
      const y = (v) => mid - (v / m) * ((bottom - top) / 2);
      const bw = Math.max(1, this.barW * 0.6);
      for (let i = first; i <= last; i++) {
        const v = ind.macd.hist[i]; if (v === null) continue;
        ctx.fillStyle = v >= 0 ? col.up : col.down; ctx.globalAlpha = 0.55;
        ctx.fillRect(this.xOf(i) - bw / 2, Math.min(mid, y(v)), bw, Math.abs(y(v) - mid));
      }
      ctx.globalAlpha = 1;
      this.line(ind.macd.line, first, last, y, col.ema20, 1.3);
      this.line(ind.macd.signal, first, last, y, col.ema50, 1.3);
      ctx.fillStyle = col.text; ctx.fillText('MACD 12 26 9', 6, pane.top + 11);
    }
    ctx.restore();
  }

  drawHover(L, col, y) {
    const { ctx, candles } = this;
    const hv = this.hover;
    const n = candles.length;
    let idx = n - 1;
    if (hv && hv.x < this.plotW) {
      const rightIndex = n - 1 - this.offset;
      idx = Math.round(rightIndex - (this.plotW - 6 - this.barW / 2 - hv.x) / this.barW);
      const projLen = this.projection && this.opts.projection ? this.projection.length : 0;
      idx = Math.max(0, Math.min(n - 1 + projLen, idx));
      const X = Math.round(this.xOf(idx)) + 0.5;
      ctx.strokeStyle = col.text; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, this.h - L.timeH);
      if (hv.y < L.mainH) { ctx.moveTo(0, Math.round(hv.y) + 0.5); ctx.lineTo(this.plotW, Math.round(hv.y) + 0.5); }
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (hv.y < L.mainH) {
        ctx.fillStyle = col.ink; ctx.fillRect(this.plotW + 1, hv.y - 9, L.axisW - 2, 18);
        ctx.fillStyle = col.bg; ctx.font = '600 11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtPrice(this.yInv(hv.y)), this.plotW + 5, hv.y);
      }
    }
    this.hoverIndex = Math.min(idx, n - 1);
    if (idx >= n && this.projection) {
      const p = this.projection[idx - n];
      this.legend.innerHTML = `<b class="acc">AI forecast</b> <span>${timeLabel(p.t, 0, true)}</span> <span>Median <b>${fmtPrice(p.p50)}</b></span> <span>Likely ${fmtPrice(p.p25)} – ${fmtPrice(p.p75)}</span>`;
      return;
    }
    const c = candles[this.hoverIndex];
    if (!c) return;
    const prev = candles[this.hoverIndex - 1];
    const ch = prev ? (c.c / prev.c - 1) * 100 : 0;
    const t = ch >= 0 ? 'up' : 'down';
    const e = (k) => { const v = this.ind?.[k]?.[this.hoverIndex]; return v === null || v === undefined ? '—' : fmtPrice(v); };
    this.legend.innerHTML = `<span>${timeLabel(c.t, 0, true)}</span>
      <span>O <b class="${t}">${fmtPrice(c.o)}</b></span><span>H <b class="${t}">${fmtPrice(c.h)}</b></span>
      <span>L <b class="${t}">${fmtPrice(c.l)}</b></span><span>C <b class="${t}">${fmtPrice(c.c)}</b></span>
      <span class="${t}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>${c.v ? `<span>Vol ${compact(c.v, '')}</span>` : ''}
      ${this.opts.ema20 ? `<span class="k1">EMA20 ${e('ema20')}</span>` : ''}${this.opts.ema50 ? `<span class="k2">EMA50 ${e('ema50')}</span>` : ''}${this.opts.ema200 ? `<span class="k7">EMA200 ${e('ema200')}</span>` : ''}`;
  }
}

function bsearch(candles, t) {
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

export function niceTicks(lo, hi, count = 5) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toPrecision(12));
  return out;
}

function timeLabel(t, spanMs, full = false) {
  const d = new Date(t);
  if (full) return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (spanMs >= 864e5) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
