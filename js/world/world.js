/**
 * The 3D layer behind every page: one full-screen canvas showing the market
 * as a trading floor (market.js): a 3D candlestick chart of real candles,
 * the largest coins as tokens, a gold coin at the centre.
 *
 * It talks to the app only through window events: `cv:route` (a page opened,
 * from js/app.js) and `cv:tickers` (the exchange's live 24-hour moves), and
 * reads candles through the app's own market API.
 *
 * Progressive: without WebGL, or if three.js fails to load, the page keeps its
 * still gold-on-obsidian background. Frames are drawn only while something
 * moves: the Markets page's slow orbit while its headline is on screen, a
 * gentler motion at the top of other pages (24 frames a second, none once the
 * page is scrolled into its panels), the glide to a new page's view, a token's
 * light changing. With reduced motion nothing moves on its own, the scene is
 * shown built, and a new page's view is a cut. Rendering pauses while the tab
 * is hidden, and steps down in resolution and glow if the device cannot keep up.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { markets, isStable, getCandles } from '../api/market.js';
import { money, pct } from '../format.js';
import { createMarket } from './market.js';
import { ringCoins, ringSize, tickerChange } from './mapping.js';

const root = document.documentElement;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const STILL = 7.5; // the moment the world is frozen at when motion is reduced
const GLIDE_MS = 1600;

function supportsWebGL() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

const routeNow = () => {
  const [name = '', ...params] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { name: root.dataset.page || name || 'markets', params };
};

let started = false;

/** Builds the world once the first page is drawn (js/app.js). */
export async function startWorld() {
  if (started) return;
  started = true;
  const canvas = document.getElementById('world');
  if (!canvas || !supportsWebGL()) {
    root.classList.add('no-webgl');
    return;
  }
  const wide = finePointer.matches && Math.min(innerWidth, innerHeight) > 700;
  const coins = ringCoins(await markets().catch(() => []), { size: ringSize(wide), stable: isStable });
  if (coins.length < 6) {
    root.classList.add('no-webgl');
    return;
  }
  try {
    boot(canvas, coins, wide);
  } catch (error) {
    console.error(error);
    root.classList.add('no-webgl');
  }
}

function boot(canvas, coins, wide) {
  let tier = wide ? 2 : 1;
  const dprFor = (t) => Math.min(devicePixelRatio || 1, t === 2 ? 1.75 : t === 1 ? 1.35 : 1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !wide, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(dprFor(tier));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // a phone draws without the glow pass, so its gold is lit a little brighter instead
  const exposureFor = (t) => (t === 2 ? 1.05 : 1.3);
  renderer.toneMappingExposure = exposureFor(tier);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const tip = document.getElementById('worldTip');
  const ring = createMarket({ envMap, quality: () => tier, pixelRatio: () => renderer.getPixelRatio() }, { coins, tip, money, pct });
  if (motion.matches) ring.skipIntro();

  // The chart's candles: Bitcoin's last hours, or on a coin's page that coin's.
  // A request that comes back after the page changed again is dropped.
  let wantChart = null;
  async function chartFor(symbol) {
    const sym = String(symbol || 'BTC').toUpperCase();
    if (wantChart === sym && ring.chartSymbol === sym) return;
    wantChart = sym;
    try {
      const list = await markets().catch(() => []);
      const coin = list.find((c) => String(c.symbol).toUpperCase() === sym) || sym;
      const { candles } = await getCandles(coin, '1h', 72);
      if (wantChart !== sym || !candles?.length) return;
      ring.setCandles(sym, candles);
      needsRender = true;
    } catch {
      // a coin with no candles keeps the chart it had, or Bitcoin's
      if (wantChart === sym && sym !== 'BTC' && ring.chartSymbol !== 'BTC') { wantChart = null; chartFor('BTC'); }
    }
  }

  // the glow on a desktop; a phone draws straight to the screen
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.55, 0.82);
  composer.addPass(new RenderPass(ring.scene, ring.camera));
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const draw = () => (tier === 2 ? composer.render() : renderer.render(ring.scene, ring.camera));

  let width = 1;
  let height = 1;
  let needsRender = true;
  // a live price moved the newest candle or a token's light: drawn at once
  // where the world moves anyway, else at most every five seconds (behind a
  // page's panels, or with reduced motion, nobody needs it sooner)
  let tickDirty = false;
  let lastDrawn = 0;
  let paused = false;
  let ready = false;
  let page = routeNow().name;
  let heroVisible = false;
  const heroEl = () => (page === 'markets' ? document.querySelector('#view .hero') : null);
  const sideWidth = () => (innerWidth > 860 ? document.querySelector('.sidebar')?.offsetWidth || 0 : 0);
  const checkHero = () => {
    const was = heroVisible;
    heroVisible = page === 'markets' && scrollY < innerHeight * 0.55;
    if (heroVisible && !was) needsRender = true;
  };

  function resize() {
    width = canvas.clientWidth || innerWidth;
    height = canvas.clientHeight || innerHeight;
    renderer.setSize(width, height, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    ring.resize(width, height, sideWidth());
    needsRender = true;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();
  ring.show(page, routeNow().params, 0);
  checkHero();
  chartFor(page === 'coin' ? routeNow().params[0] : 'BTC');

  // ---- quality steps down, never up, so it cannot flicker between the two
  let frames = 0;
  let slow = 0;
  let warmup = 45;
  function setTier(next) {
    tier = Math.max(0, next);
    renderer.setPixelRatio(dprFor(tier));
    renderer.toneMappingExposure = exposureFor(tier);
    resize();
  }
  function adapt(dt) {
    if (warmup > 0) {
      warmup -= 1;
      return;
    }
    if (tier === 0) return;
    frames += 1;
    if (dt > (tier === 2 ? 1 / 38 : 1 / 22)) slow += 1; // a phone's target is 30 frames a second
    if (frames >= 90) {
      if (slow > 45) setTier(tier - 1);
      frames = 0;
      slow = 0;
    }
  }

  // ---- the loop: a frame only when something moves
  let last = performance.now();
  let time = 0;
  // Moving on its own: the Markets page while its headline is on screen; any
  // other page gently, while it is at its top (behind its panels, further
  // down, the motion would only cost the battery).
  const atTop = () => scrollY < innerHeight * 0.6;
  function loop(now) {
    requestAnimationFrame(loop);
    const live = !motion.matches && (page === 'markets' ? heroVisible : atTop());
    const tickDue = tickDirty && (live || now - lastDrawn > 5000);
    if (paused || document.hidden || (!live && !needsRender && !ring.gliding && !tickDue)) {
      last = now;
      return;
    }
    // a phone draws the slow orbit at 30 frames a second, other pages draw at
    // 24: half the work or less for the same look; the time skipped counts at
    // the next frame drawn
    const gap = page === 'markets' ? (tier < 2 ? 1000 / 30 : 0) : 1000 / 24;
    if (live && !ring.gliding && !needsRender && now - last < gap - 3) return;
    tickDirty = false;
    lastDrawn = now;
    // a frame's timestamp can precede the clock reading taken before it was requested, so never step backwards
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    if (live) time += dt;
    const moving = ring.update(motion.matches ? STILL : time, live || ring.gliding ? dt : 0, now);
    draw();
    needsRender = moving;
    if (live && page === 'markets') adapt(dt);
    const hero = heroEl();
    if (hero) hero.style.cursor = tip && !tip.hidden ? 'pointer' : '';
    if (!ready) {
      ready = true;
      root.classList.add('webgl');
    }
  }
  requestAnimationFrame(loop);

  // ---- input: point at a token in the Markets page's headline to name it, click to open it
  const overHero = (e) => {
    const hero = heroEl();
    return Boolean(hero && heroVisible && e.target instanceof Element && e.target.closest('.hero') === hero && !e.target.closest('a, button, input, select, textarea, label'));
  };
  addEventListener('pointermove', (e) => {
    if (page !== 'markets') return;
    ring.pointerMove(e.clientX, e.clientY, overHero(e));
    if (heroVisible) needsRender = true;
  }, { passive: true });
  root.addEventListener('pointerleave', () => {
    ring.pointerLeave();
    needsRender = true;
  });
  addEventListener('click', (e) => {
    if (!overHero(e)) return;
    const coin = ring.pick(e.clientX, e.clientY);
    if (coin) location.hash = `#/coin/${encodeURIComponent(coin.symbol)}`;
  });
  addEventListener('scroll', checkHero, { passive: true });

  // ---- the app: a new page turns the world to its view
  addEventListener('cv:route', (e) => {
    page = e.detail?.name || 'markets';
    ring.show(page, e.detail?.params || [], motion.matches || tier === 0 ? 0 : GLIDE_MS);
    checkHero();
    chartFor(page === 'coin' ? e.detail?.params?.[0] : 'BTC');
    needsRender = true;
  });
  // the exchange's stream: a coin's light follows its 24-hour move as it changes
  addEventListener('cv:tickers', (e) => {
    let changed = false;
    for (const t of e.detail || []) {
      const ch = tickerChange(t);
      const sym = String(t.s || '').replace(/USDT$/, '');
      if (ch !== null && ring.setChange(sym, ch, +t.c)) changed = true;
      if (ring.setTick(sym, +t.c)) changed = true;
    }
    if (changed) tickDirty = true;
  });
  // caps and moves for the coins the stream does not cover
  setInterval(() => {
    if (document.hidden) return;
    markets().then((list) => {
      ring.setCoins(list);
      needsRender = true;
    }).catch(() => {});
  }, 120e3);

  document.addEventListener('visibilitychange', () => {
    last = performance.now();
    needsRender = true;
  });
  motion.addEventListener('change', () => {
    needsRender = true;
  });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    paused = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    paused = false;
    needsRender = true;
  });
}
