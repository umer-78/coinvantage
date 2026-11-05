/**
 * The market as a place: a trading floor built from live data (mapping.js).
 *
 * - Behind everything, a 3D candlestick chart: a coin's last hours of real
 *   candles stood on an arc, jade for a candle that closed up and coral for
 *   one that closed down, with its average line, its last price and the
 *   chart's grid. It turns with the camera, so it always stands behind the
 *   scene, oldest candle on the left and newest on the right. Bitcoin's on
 *   most pages; on a coin's page, that coin's. The newest candle moves with
 *   the exchange's live price.
 * - In front of the chart, the largest coins as tokens with their tickers on
 *   them, in two rows behind the centre (largest in front): a token's size is
 *   its coin's market cap, the light on its rim the last 24 hours. Point at
 *   one on the Markets page to name it; click to open its chart. On a coin's
 *   page its token is lit and lifted, and the chart is that coin's.
 * - At the centre, a gold coin struck with ₿, ringed by network nodes, on a
 *   pedestal over a trading-terminal grid.
 *
 * The scene builds itself the first time it is shown (candles rise left to
 * right, tokens come up from the floor), unless motion is reduced.
 */
import * as THREE from 'three';
import { GLOW_POINTS_FRAG } from './glsl.js';
import { tokenSize, gemFor, ripple, breadth, viewOf, candleBars, ema, arcAngle } from './mapping.js';

const ROWS = [{ r: 6.3, lift: 0 }, { r: 8.6, lift: 1.05 }]; // the tokens' two rows, front and back
const TOKEN_SPAN = 3.3;    // radians the rows cover behind the centre (about 189°)
const CHART_R = 13;        // the candle chart's arc
const CHART_SPAN = 2.25;   // radians of arc the chart covers (about 129°)
const MAX_CANDLES = 72;
const COIN_R = 1.45;
const COIN_Y = 2.25;
const ATLAS_COLS = 6;      // ticker faces: a 6 × 6 atlas (36 tokens at most)
const INTRO_S = 2.2;

export function createMarket({ envMap, quality, pixelRatio }, { coins, tip, money, pct }) {
  const q = quality();
  const scene = new THREE.Scene();
  const bg = new THREE.Color('#050506');
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 20, 56);
  scene.environment = envMap;
  scene.environmentIntensity = 0.6;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  const uTime = { value: 0 };
  const gold = new THREE.Color('#d8b46e');
  const upColor = new THREE.Color('#5fd3a5');
  const downColor = new THREE.Color('#f2877b');
  const UP = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4();
  const m4b = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  let intro = 0; // 0 → 1 while the scene builds itself
  let introStart = null;
  let focus = null; // the token of the coin whose page is open
  let chartYaw = 0; // the chart and the token rows turn with the camera

  // ---------------------------------------------------------------- tokens
  const caps = coins.map((c) => c.marketCap);
  let lo = Math.min(...caps), hi = Math.max(...caps);
  // the largest coins in the front row, spread out from just beside the centre
  const list = coins.slice(0, ATLAS_COLS * ATLAS_COLS);
  const front = Math.ceil(list.length / 2);
  const slots = (n) => {
    const order = [];
    for (let k = 0; k < n; k++) order.push(n % 2 ? (k % 2 ? -1 : 1) * Math.ceil(k / 2) : (k % 2 ? -1 : 1) * (Math.floor(k / 2) + 0.5));
    return order.map((o) => (o / Math.max(1, n - 1)) * TOKEN_SPAN);
  };
  const frontSlots = slots(front), backSlots = slots(list.length - front);
  const items = list.map((coin, i) => {
    const gem = gemFor(coin.change24h);
    let seed = 0;
    for (const ch of coin.symbol) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    const size = tokenSize(coin.marketCap, lo, hi, { min: 0.32, max: 0.74 });
    const row = i < front ? 0 : 1;
    return {
      coin, cell: i, seed: seed / 9973, row,
      // the centre slot of an odd row sits behind the coin: start beside it
      angle: row === 0 ? frontSlots[i] : backSlots[i - front],
      size, sizeTo: size,
      color: new THREE.Color(gem.color), colorTo: new THREE.Color(gem.color),
      glow: gem.glow, glowTo: gem.glow,
      hover: 0, hoverTo: 0,
      x: 0, y: 0, z: 0,
    };
  });
  const N = items.length;

  // the tickers, one cell each: text in the red channel, the face's ring in the green
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = atlasCanvas.height = 1024;
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = 4;
  function drawAtlas() {
    const g = atlasCanvas.getContext('2d');
    const cell = 1024 / ATLAS_COLS;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 1024, 1024);
    g.globalCompositeOperation = 'lighter';
    items.forEach((it, i) => {
      const cx = (i % ATLAS_COLS) * cell + cell / 2, cy = Math.floor(i / ATLAS_COLS) * cell + cell / 2, r = cell / 2;
      g.strokeStyle = '#00ff00';
      g.lineWidth = r * 0.05;
      g.beginPath(); g.arc(cx, cy, r * 0.84, 0, Math.PI * 2); g.stroke();
      const sym = String(it.coin.symbol).slice(0, 6);
      const fs = r * (sym.length <= 3 ? 0.56 : sym.length === 4 ? 0.46 : 0.36);
      g.fillStyle = '#ff0000';
      g.font = `700 ${fs}px Manrope, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(sym, cx, cy + fs * 0.05);
    });
    g.globalCompositeOperation = 'source-over';
    atlas.needsUpdate = true;
  }
  drawAtlas();
  // drawn again once the page's font has loaded, so the tickers are set in it
  document.fonts?.load?.('700 48px Manrope').then(() => { drawAtlas(); }).catch(() => {});

  const gemAttr = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
  const hoverAttr = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
  items.forEach((it, i) => { it.color.toArray(gemAttr.array, i * 3); glowAttr.array[i] = it.glow; });

  const faceGeo = new THREE.CircleGeometry(1, 56);
  faceGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(items.map((it) => it.cell)), 1));
  faceGeo.setAttribute('aGem', gemAttr);
  faceGeo.setAttribute('aGlow', glowAttr);
  faceGeo.setAttribute('aHover', hoverAttr);
  const faceMat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uCols: { value: ATLAS_COLS } },
    vertexShader: /* glsl */ `
      attribute float aCell; attribute vec3 aGem; attribute float aGlow; attribute float aHover;
      uniform float uCols;
      varying vec2 vUv; varying vec3 vGem; varying float vGlow; varying float vHover; varying vec2 vLocal;
      void main() {
        float col = mod(aCell, uCols), row = floor(aCell / uCols);
        vUv = (vec2(col, uCols - 1.0 - row) + uv) / uCols;
        vLocal = position.xy;
        vGem = aGem; vGlow = aGlow; vHover = aHover;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      varying vec2 vUv; varying vec3 vGem; varying float vGlow; varying float vHover; varying vec2 vLocal;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        float r = length(vLocal);
        // a dark metal face, lit a little toward its upper edge
        vec3 col = vec3(0.028, 0.026, 0.024) + vec3(0.05, 0.045, 0.035) * (0.5 + 0.5 * vLocal.y);
        col = mix(col, vec3(0.96, 0.93, 0.86), t.r * (0.82 + 0.18 * vHover));
        col += vGem * t.g * (0.45 + 0.75 * vGlow) * (1.0 + vHover);
        col += vGem * smoothstep(0.7, 1.0, r) * 0.08 * vGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  faceMat.polygonOffset = true;
  faceMat.polygonOffsetFactor = -1;
  faceMat.polygonOffsetUnits = -4;
  const faces = new THREE.InstancedMesh(faceGeo, faceMat, N);

  const bodyGeo = new THREE.CylinderGeometry(1, 1, 0.14, 56, 1);
  bodyGeo.rotateX(Math.PI / 2); // a token stands upright, its faces front and back
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x0f0d0b, metalness: 0.85, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 1.1 });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, N);

  const rimGeo = new THREE.TorusGeometry(1, 0.055, 10, 72);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const rims = new THREE.InstancedMesh(rimGeo, rimMat, N);
  for (const mesh of [faces, bodies, rims]) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(bodies, faces, rims);

  // the face sits clear of the body's own cap, or the two fight over the same depth
  const FACE_OFF = new THREE.Matrix4().makeTranslation(0, 0, 0.082);
  const rimColor = new THREE.Color();
  function placeToken(i, eyeX, eyeZ) {
    const it = items[i];
    const rise = Math.min(1, Math.max(0, intro * 1.4 - 0.25 - (i / N) * 0.3));
    const bob = Math.sin(uTime.value * 0.8 + it.seed * 6.2832) * 0.07;
    const lit = Math.max(it.hover, it === focus ? 1 : 0);
    const s = it.size * (1 + lit * 0.18);
    // the rows stand behind the centre and turn with the chart, so the front
    // of the scene stays open
    const { r, lift } = ROWS[it.row];
    const lx = Math.sin(it.angle) * r, lz = -Math.cos(it.angle) * r;
    const c = Math.cos(chartYaw), sn = Math.sin(chartYaw);
    it.x = lx * c + lz * sn;
    it.z = -lx * sn + lz * c;
    it.y = 0.25 + lift + it.size + bob + lit * 0.3 - (1 - easeOut(rise)) * 3.2;
    // each token turns to face the camera, so its ticker can be read
    quat.setFromAxisAngle(UP, Math.atan2(eyeX - it.x, eyeZ - it.z));
    pos.set(it.x, it.y, it.z);
    scl.set(s, s, s);
    m4.compose(pos, quat, scl);
    bodies.setMatrixAt(i, m4);
    rims.setMatrixAt(i, m4);
    faces.setMatrixAt(i, m4b.multiplyMatrices(m4, FACE_OFF));
  }
  function paintRim(i) {
    const it = items[i];
    rims.setColorAt(i, rimColor.copy(it.color).multiplyScalar(0.55 + 0.6 * it.glow + 0.5 * Math.max(it.hover, it === focus ? 1 : 0)));
  }
  items.forEach((_, i) => paintRim(i));

  // ---------------------------------------------------------------- the coin at the centre
  const emblemCanvas = document.createElement('canvas');
  emblemCanvas.width = emblemCanvas.height = 512;
  {
    const g = emblemCanvas.getContext('2d');
    const c = 256;
    g.fillStyle = '#808080'; g.fillRect(0, 0, 512, 512);
    // a raised rim, a ring of dots inside it, and the struck ₿
    g.strokeStyle = '#ffffff'; g.lineWidth = 30;
    g.beginPath(); g.arc(c, c, 241, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffffff';
    for (let k = 0; k < 60; k++) { const a = (k / 60) * Math.PI * 2; g.beginPath(); g.arc(c + Math.cos(a) * 204, c + Math.sin(a) * 204, 5, 0, Math.PI * 2); g.fill(); }
    g.lineWidth = 5; g.beginPath(); g.arc(c, c, 186, 0, Math.PI * 2); g.stroke();
    g.font = '700 260px Manrope, system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('₿', c, c + 10);
  }
  const emblem = new THREE.CanvasTexture(emblemCanvas);
  emblem.colorSpace = THREE.NoColorSpace;
  emblem.center.set(0.5, 0.5);
  emblem.rotation = Math.PI / 2; // the cap's coordinates run sideways once the coin stands up
  const coinGeo = new THREE.CylinderGeometry(COIN_R, COIN_R, 0.26, 128, 1);
  coinGeo.rotateX(Math.PI / 2);
  const coinFace = new THREE.MeshPhysicalMaterial({ color: '#e7c37c', metalness: 1, roughness: 0.2, clearcoat: 0.5, clearcoatRoughness: 0.12, envMapIntensity: 1.45, bumpMap: emblem, bumpScale: 4 });
  const coinEdge = new THREE.MeshPhysicalMaterial({ color: '#c79f58', metalness: 1, roughness: 0.34, envMapIntensity: 1.35 });
  const coin = new THREE.Mesh(coinGeo, [coinEdge, coinFace, coinFace]);
  coin.position.y = COIN_Y;
  scene.add(coin);

  const obsidian = new THREE.MeshPhysicalMaterial({ color: 0x0a0a0c, metalness: 0.2, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
  const goldMat = new THREE.MeshPhysicalMaterial({ color: gold, metalness: 1, roughness: 0.26, envMapIntensity: 1.4 });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.25, 0.42, 72), obsidian);
  pedestal.position.y = 0.21;
  const lip = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.028, 10, 120), goldMat);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.42;
  scene.add(pedestal, lip);

  // a ring of network nodes around the coin, linked like a chain
  const NODES = q >= 1 ? 36 : 24;
  const nodePos = new Float32Array(NODES * 3);
  for (let k = 0; k < NODES; k++) {
    const a = (k / NODES) * Math.PI * 2;
    nodePos.set([Math.cos(a) * 2.35, Math.sin(a * 3) * 0.12, Math.sin(a) * 2.35], k * 3);
  }
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(NODES).fill(2.4), 1));
  nodeGeo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(NODES).map((_, k) => k / NODES), 1));
  nodeGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(NODES * 3).map((_, k) => [0.95, 0.8, 0.5][k % 3]), 3));
  const nodeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime, uPR: { value: pixelRatio() } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aSeed; attribute vec3 aColor;
      uniform float uTime; uniform float uPR;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColor = aColor;
        vAlpha = 0.55 + 0.45 * sin(uTime * 2.0 + aSeed * 40.0);
        gl_PointSize = aSize * uPR * (14.0 / max(-mv.z, 0.5));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLOW_POINTS_FRAG,
  });
  const linkIdx = [];
  for (let k = 0; k < NODES; k++) { linkIdx.push(k, (k + 1) % NODES); if (k % 4 === 0) linkIdx.push(k, (k + NODES / 2 - 3) % NODES); }
  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  linkGeo.setIndex(linkIdx);
  const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: gold, transparent: true, opacity: 0.32, depthWrite: false }));
  const network = new THREE.Group();
  network.add(new THREE.Points(nodeGeo, nodeMat), links);
  network.position.y = COIN_Y;
  network.rotation.x = 0.32;
  scene.add(network);

  // ---------------------------------------------------------------- the 3D candle chart
  const chart = new THREE.Group();
  scene.add(chart);
  const candleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.15, envMapIntensity: 0.6 });
  // the candles glow with their own colour (and bloom on a desktop)
  candleMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
        totalEmissiveRadiance += vColor.rgb * 0.42;
      #endif`);
  };
  const box = new THREE.BoxGeometry(1, 1, 1);
  const candleBodies = new THREE.InstancedMesh(box, candleMat, MAX_CANDLES);
  const candleWicks = new THREE.InstancedMesh(box, candleMat, MAX_CANDLES);
  for (const mesh of [candleBodies, candleWicks]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
  }
  chart.add(candleBodies, candleWicks);
  const lineMat = new THREE.LineBasicMaterial({ color: gold, transparent: true, opacity: 0.16, depthWrite: false });
  const grid = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  const priceMat = new THREE.LineDashedMaterial({ color: gold, transparent: true, opacity: 0.75, dashSize: 0.35, gapSize: 0.22, depthWrite: false });
  const priceLine = new THREE.Line(new THREE.BufferGeometry(), priceMat);
  const avgMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#e9c98a'), transparent: true, opacity: 0.85 });
  let avgLine = null;
  chart.add(grid, priceLine);
  let candles = [];
  let chartSymbol = null;

  const arcPoint = (a, y, r = CHART_R) => new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
  function layoutChart() {
    const bars = candleBars(candles.slice(-MAX_CANDLES), { floor: 0.9, top: 7.4 });
    const n = bars.length;
    const step = (CHART_R * CHART_SPAN) / Math.max(1, n - 1);
    const w = step * 0.6;
    bars.forEach((b, i) => {
      const a = arcAngle(i, n, CHART_SPAN);
      const grow = easeOut(Math.min(1, Math.max(0, intro * 1.6 - (i / n) * 0.9)));
      const x = Math.sin(a) * CHART_R, z = -Math.cos(a) * CHART_R;
      quat.setFromAxisAngle(UP, -a);
      const h = Math.max(0.0001, (b.bodyHi - b.bodyLo) * grow);
      const mid = 0.9 + ((b.bodyLo + b.bodyHi) / 2 - 0.9) * grow;
      pos.set(x, mid, z);
      scl.set(w, h, w * 0.5);
      candleBodies.setMatrixAt(i, m4.compose(pos, quat, scl));
      const wh = Math.max(0.0001, (b.wickHi - b.wickLo) * grow);
      const wmid = 0.9 + ((b.wickLo + b.wickHi) / 2 - 0.9) * grow;
      pos.set(x, wmid, z);
      scl.set(w * 0.12, wh, w * 0.12);
      candleWicks.setMatrixAt(i, m4.compose(pos, quat, scl));
      const col = b.up ? upColor : downColor;
      candleBodies.setColorAt(i, col);
      candleWicks.setColorAt(i, col);
    });
    candleBodies.count = candleWicks.count = n;
    candleBodies.instanceMatrix.needsUpdate = candleWicks.instanceMatrix.needsUpdate = true;
    if (candleBodies.instanceColor) candleBodies.instanceColor.needsUpdate = true;
    if (candleWicks.instanceColor) candleWicks.instanceColor.needsUpdate = true;
    if (!n) return;
    const shown = intro >= 1;
    // the grid: five levels of the price axis across the arc
    const gp = [];
    for (let k = 0; k <= 4; k++) {
      const y = 0.9 + (k / 4) * (7.4 - 0.9);
      for (let s = 0; s < 48; s++) {
        const a0 = -CHART_SPAN / 2 - 0.05 + (s / 48) * (CHART_SPAN + 0.1), a1 = -CHART_SPAN / 2 - 0.05 + ((s + 1) / 48) * (CHART_SPAN + 0.1);
        gp.push(...arcPoint(a0, y, CHART_R + 0.6).toArray(), ...arcPoint(a1, y, CHART_R + 0.6).toArray());
      }
    }
    grid.geometry.dispose();
    grid.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    // the last price, across the whole chart
    const last = bars[n - 1];
    const pp = [];
    for (let s = 0; s <= 64; s++) pp.push(arcPoint(-CHART_SPAN / 2 - 0.05 + (s / 64) * (CHART_SPAN + 0.1), last.close, CHART_R - 0.35));
    priceLine.geometry.dispose();
    priceLine.geometry = new THREE.BufferGeometry().setFromPoints(pp);
    priceLine.computeLineDistances();
    priceLine.visible = shown;
    // the 20-candle average, as a tube through the candles
    const avg = ema(bars.map((b) => b.close), 20);
    const pts = avg.map((v, i) => arcPoint(arcAngle(i, n, CHART_SPAN), v, CHART_R - 0.05)).filter((p) => Number.isFinite(p.y));
    if (avgLine) { chart.remove(avgLine); avgLine.geometry.dispose(); avgLine = null; }
    if (pts.length > 3 && shown) {
      avgLine = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, 0.035, 6, false), avgMat);
      chart.add(avgLine);
    }
  }

  // ---------------------------------------------------------------- the floor: a trading terminal's grid
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uGold: { value: gold }, uBg: { value: bg }, uRing: { value: ROWS[0].r } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGold; uniform vec3 uBg; uniform float uRing;
      varying vec3 vWorld;
      float lines(vec2 p, float size, float px) {
        vec2 g = abs(fract(p / size - 0.5) - 0.5) * size;
        return 1.0 - smoothstep(0.0, px * 1.4, min(g.x, g.y));
      }
      float ring(float r, float at, float px) { return 1.0 - smoothstep(0.0, px * 1.4, abs(r - at)); }
      void main() {
        float r = length(vWorld.xz);
        float px = fwidth(r) + 0.0005;
        vec3 col = vec3(0.011, 0.0105, 0.012);
        float g = lines(vWorld.xz, 1.0, fwidth(vWorld.x) + fwidth(vWorld.z)) * 0.14 + lines(vWorld.xz, 5.0, fwidth(vWorld.x) + fwidth(vWorld.z)) * 0.3;
        float rings = ring(r, uRing, px) * 0.75 + ring(r, uRing + 0.9, px) * 0.3 + ring(r, 2.35, px) * 0.45;
        col += uGold * (g + rings) * 0.36;
        col += uGold * 0.11 * exp(-r * r / 7.0);
        float fade = smoothstep(36.0, 9.0, r);
        gl_FragColor = vec4(mix(uBg, col, fade), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---------------------------------------------------------------- data rising: jade where the ring rose, coral where it fell
  const DUST = q >= 2 ? 700 : q === 1 ? 380 : 200;
  const dustGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DUST * 3), dSize = new Float32Array(DUST), dSeed = new Float32Array(DUST), dColor = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i += 1) {
    const r = 2.5 + Math.sqrt(Math.random()) * 15;
    const a = Math.random() * Math.PI * 2;
    dPos.set([Math.cos(a) * r, Math.random() * 10, Math.sin(a) * r], i * 3);
    dSize[i] = 0.5 + Math.random() * Math.random() * 2.2;
    dSeed[i] = Math.random();
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dSeed, 1));
  const dustColor = new THREE.BufferAttribute(dColor, 3);
  dustGeo.setAttribute('aColor', dustColor);
  const uSpeed = { value: 1 };
  const dustMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime, uSpeed, uPR: { value: pixelRatio() } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aSeed; attribute vec3 aColor;
      uniform float uTime; uniform float uSpeed; uniform float uPR;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.08 + aSeed * 0.14) * uSpeed, 10.0);
        p.x += sin(uTime * 0.21 + aSeed * 40.0) * 0.35;
        p.z += cos(uTime * 0.17 + aSeed * 31.0) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vColor = aColor;
        vAlpha = smoothstep(0.0, 1.2, p.y) * smoothstep(10.0, 7.5, p.y) * (0.5 + 0.5 * sin(uTime * 1.7 + aSeed * 60.0));
        gl_PointSize = aSize * uPR * (10.0 / max(-mv.z, 0.5));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLOW_POINTS_FRAG,
  });
  scene.add(new THREE.Points(dustGeo, dustMat));
  function paintDust() {
    const share = breadth(items.map((it) => it.coin.change24h));
    const c = new THREE.Color();
    for (let i = 0; i < DUST; i += 1) {
      const k = dSeed[i];
      c.copy(k < share * 0.85 ? upColor : k > 1 - (1 - share) * 0.85 ? downColor : gold);
      c.toArray(dColor, i * 3);
    }
    dustColor.needsUpdate = true;
    uSpeed.value = 0.6 + ripple(items.map((it) => it.coin.change24h)) * 5;
  }
  paintDust();

  // ---------------------------------------------------------------- light
  const coinLight = new THREE.PointLight('#ffd79a', 18, 0, 2);
  coinLight.position.set(0, COIN_Y + 1.2, 2.2);
  const key = new THREE.DirectionalLight('#fff0d8', 0.75);
  key.position.set(4, 10, 6);
  const rimLight = new THREE.DirectionalLight('#9fd8ff', 0.25);
  rimLight.position.set(-6, 4, -8);
  scene.add(coinLight, key, rimLight);

  // ---------------------------------------------------------------- the view
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const label = tipParts(tip);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, px: -1, py: -1, moved: false, inside: false };
  let width = 1, height = 1, sideWidth = 0;
  let orbit = 0;
  let hovered = null;
  let page = 'markets';
  const eye = new THREE.Vector3(), look = new THREE.Vector3();
  const goalEye = new THREE.Vector3(), goalLook = new THREE.Vector3();
  const fromEye = new THREE.Vector3(), fromLook = new THREE.Vector3();
  let glide = null;
  let placed = false;

  // The scene stands in the part of the screen the page leaves open: right of
  // the sidebar, and on the Markets page above its headline. Elsewhere it sits
  // low, behind the panels, so nothing bright stands behind a page's opening words.
  function frame() {
    const w = width, h = height;
    const wide = w / h > 1.15;
    camera.aspect = w / h;
    camera.fov = wide ? 34 : w / h < 0.8 ? 58 : 44;
    const home = page === 'markets';
    const x = -sideWidth / 2 - (wide ? w * (home ? 0.06 : 0.12) : 0);
    const y = home ? h * (wide ? 0.2 : 0.18) : -h * 0.04;
    camera.setViewOffset(w, h, x, y, w, h);
    camera.updateProjectionMatrix();
  }

  function goal() {
    const portrait = width / height < 0.9;
    const v = viewOf(page);
    if (!v) {
      // the Markets page: a slow orbit, nudged by the pointer
      const dist = portrait ? 25 : 28.5;
      const a = orbit + pointer.sx * 0.12;
      goalEye.set(Math.sin(a) * dist, 7.2 + pointer.sy * 0.8, Math.cos(a) * dist);
      goalLook.set(0, 2.9, 0);
      return;
    }
    const [a, dist, y, ty] = v;
    goalEye.set(Math.sin(a) * dist * (portrait ? 1.2 : 1), y, Math.cos(a) * dist * (portrait ? 1.2 : 1));
    goalLook.set(0, ty, 0);
  }

  function pick(x, y) {
    ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(bodies, false)[0];
    return hit && hit.instanceId != null ? items[hit.instanceId] : null;
  }

  function writeTip(item) {
    const c = item.coin;
    label.sym.textContent = Number.isFinite(c.rank) ? `${c.symbol} · #${c.rank}` : c.symbol;
    label.name.textContent = c.name || c.symbol;
    label.fig.textContent = `${money(c.price)} · ${pct(c.change24h)} in 24h`;
    tip.style.setProperty('--gem', `#${item.colorTo.getHexString()}`);
  }

  function setHover(item) {
    if (item === hovered) return;
    if (hovered) hovered.hoverTo = 0;
    hovered = item;
    if (item) item.hoverTo = 1;
    if (label) {
      if (item) writeTip(item);
      tip.hidden = !item;
    }
  }

  const tipAt = new THREE.Vector3();
  function placeTip() {
    if (!hovered || !label) return;
    tipAt.set(hovered.x, hovered.y + hovered.size * 1.3 + 0.4, hovered.z).project(camera);
    const w = tip.offsetWidth || 200;
    const h = tip.offsetHeight || 80;
    const x = Math.min(Math.max((tipAt.x * 0.5 + 0.5) * width, w / 2 + 12), width - w / 2 - 12);
    const y = Math.max((-tipAt.y * 0.5 + 0.5) * height, h + 70);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /**
   * One step of the world. Returns true while something is still settling
   * that needs another frame even when nothing moves on its own (a glide, a
   * hover easing, the scene building itself).
   */
  function update(t, dt, now) {
    uTime.value = t;
    const follow = dt > 0 ? Math.min(1, dt * 3) : 1;
    pointer.sx += (pointer.x - pointer.sx) * follow;
    pointer.sy += (pointer.y - pointer.sy) * follow;
    orbit += dt * 0.03;
    // the build runs on the clock, not on the frame step: it finishes even
    // where nothing else moves on its own
    let building = false;
    if (intro < 1) {
      introStart ??= now;
      intro = Math.min(1, (now - introStart) / (INTRO_S * 1000));
      building = true;
      layoutChart();
    }

    goal();
    if (!placed) {
      eye.copy(goalEye);
      look.copy(goalLook);
      placed = true;
    } else if (glide) {
      const k = easeInOut(Math.min(1, (now - glide.start) / glide.ms));
      eye.lerpVectors(fromEye, goalEye, k);
      look.lerpVectors(fromLook, goalLook, k);
      if (k >= 1) glide = null;
    } else {
      eye.copy(goalEye);
      look.copy(goalLook);
    }
    camera.position.copy(eye);
    camera.lookAt(look);

    // the chart turns with the camera, so it always stands behind the scene
    const yaw = Math.atan2(eye.x, eye.z);
    let d = yaw - chartYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    chartYaw += d * (glide || dt === 0 ? 1 : Math.min(1, dt * 4));
    chart.rotation.y = chartYaw;

    coin.rotation.y = Math.sin(t * 0.32) * 0.9; // turns to and fro, so its face is mostly to the viewer
    coin.position.y = COIN_Y + Math.sin(t * 0.7) * 0.07;
    coin.scale.setScalar(0.4 + 0.6 * easeOut(Math.min(1, intro * 1.8)));
    network.rotation.y = -t * 0.12;
    network.position.y = coin.position.y;

    if (pointer.moved) {
      pointer.moved = false;
      setHover(pointer.inside && !glide ? pick(pointer.px, pointer.py) : null);
    }

    const ease = dt > 0 ? Math.min(1, dt * 7) : 1;
    let settling = false;
    items.forEach((it, i) => {
      if (Math.abs(it.hoverTo - it.hover) > 0.001 || Math.abs(it.sizeTo - it.size) > 0.001) {
        it.hover += (it.hoverTo - it.hover) * ease;
        it.size += (it.sizeTo - it.size) * ease;
        hoverAttr.array[i] = it.hover;
        settling = true;
      }
      if (Math.abs(it.glowTo - it.glow) > 0.001 || !it.color.equals(it.colorTo)) {
        it.glow += (it.glowTo - it.glow) * ease;
        it.color.lerp(it.colorTo, ease);
        if (Math.abs(it.color.r - it.colorTo.r) + Math.abs(it.color.g - it.colorTo.g) + Math.abs(it.color.b - it.colorTo.b) < 0.003) it.color.copy(it.colorTo);
        glowAttr.array[i] = it.glow;
        it.color.toArray(gemAttr.array, i * 3);
        paintRim(i);
        settling = true;
      }
      placeToken(i, eye.x, eye.z);
    });
    hoverAttr.needsUpdate = glowAttr.needsUpdate = gemAttr.needsUpdate = true;
    for (const mesh of [faces, bodies, rims]) mesh.instanceMatrix.needsUpdate = true;
    if (rims.instanceColor) rims.instanceColor.needsUpdate = true;
    bodies.computeBoundingSphere();
    placeTip();
    return Boolean(glide) || building || settling;
  }

  return {
    scene,
    camera,
    update,
    get gliding() { return Boolean(glide); },
    get chartSymbol() { return chartSymbol; },
    resize(w, h, side = 0) {
      width = w;
      height = h;
      sideWidth = side;
      frame();
    },
    /** Turns to a page's view: a glide when `ms` > 0, else a cut. */
    show(name, params, ms) {
      const sym = name === 'coin' ? String(params?.[0] || '').toUpperCase() : '';
      page = name;
      const was = focus;
      focus = sym ? items.find((it) => it.coin.symbol.toUpperCase() === sym) || null : null;
      for (const it of [was, focus]) if (it) paintRim(items.indexOf(it));
      if (rims.instanceColor) rims.instanceColor.needsUpdate = true;
      setHover(null);
      frame();
      if (!placed || !(ms > 0)) {
        glide = null;
        placed = false;
        return;
      }
      fromEye.copy(eye);
      fromLook.copy(look);
      glide = { start: performance.now(), ms };
    },
    /** With motion reduced the scene is shown built, not building. */
    skipIntro() {
      intro = 1;
      layoutChart();
    },
    /** A coin's candles for the chart (oldest first). */
    setCandles(symbol, list) {
      chartSymbol = symbol;
      candles = (list || []).filter((c) => Number.isFinite(c?.c)).slice(-MAX_CANDLES);
      layoutChart();
    },
    /** The exchange's live price for the chart's coin: the newest candle follows it. */
    setTick(symbol, price) {
      if (symbol !== chartSymbol || !(price > 0) || !candles.length) return false;
      const lastC = candles[candles.length - 1];
      if (lastC.c === price) return false;
      candles[candles.length - 1] = { ...lastC, c: price, h: Math.max(lastC.h, price), l: Math.min(lastC.l, price) };
      layoutChart();
      return true;
    },
    /** New readings: a coin's cap sets its token's size, its 24-hour move its light. */
    setCoins(list) {
      const by = new Map(list.map((c) => [String(c.symbol).toUpperCase(), c]));
      const fresh = items.map((it) => by.get(it.coin.symbol.toUpperCase())).filter(Boolean);
      const capsNow = fresh.map((c) => c.marketCap).filter((x) => x > 0);
      if (capsNow.length) { lo = Math.min(...capsNow); hi = Math.max(...capsNow); }
      for (const it of items) {
        const c = by.get(it.coin.symbol.toUpperCase());
        if (!c) continue;
        it.coin = { ...it.coin, ...c };
        if (c.marketCap > 0) it.sizeTo = tokenSize(c.marketCap, lo, hi);
        const gem = gemFor(it.coin.change24h);
        it.colorTo.set(gem.color);
        it.glowTo = gem.glow;
      }
      paintDust();
    },
    /** A live 24-hour move for one coin (from the exchange's stream). */
    setChange(symbol, change, price) {
      const it = items.find((x) => x.coin.symbol.toUpperCase() === symbol);
      if (!it || !Number.isFinite(change)) return false;
      it.coin = { ...it.coin, change24h: change, ...(Number.isFinite(price) ? { price } : {}) };
      const gem = gemFor(change);
      const changed = !it.colorTo.equals(new THREE.Color(gem.color)) || Math.abs(it.glowTo - gem.glow) > 0.02;
      it.colorTo.set(gem.color);
      it.glowTo = gem.glow;
      if (it === hovered && label) writeTip(it);
      return changed;
    },
    pointerMove(x, y, inside) {
      pointer.x = (x / width) * 2 - 1;
      pointer.y = (y / height) * 2 - 1;
      pointer.px = x;
      pointer.py = y;
      pointer.inside = inside;
      pointer.moved = true;
    },
    pointerLeave() {
      pointer.inside = false;
      pointer.moved = true;
    },
    /** The coin under a point on the screen, if any. */
    pick(x, y) {
      return pick(x, y)?.coin || null;
    },
    clearHover() {
      setHover(null);
    },
  };
}

const easeOut = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** The hover label's parts, made once; text goes in through textContent only. */
function tipParts(tip) {
  if (!tip) return null;
  tip.textContent = '';
  const sym = document.createElement('span');
  sym.className = 't-sym';
  const name = document.createElement('strong');
  name.className = 't-name';
  const fig = document.createElement('span');
  fig.className = 't-fig';
  const cta = document.createElement('span');
  cta.className = 't-cta';
  cta.textContent = 'Open its chart →';
  tip.append(sym, name, fig, cta);
  return { sym, name, fig };
}
