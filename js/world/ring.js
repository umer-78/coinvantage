/**
 * The market as a place, in the portfolio's design (umer-78.github.io,
 * scripts/gallery.js): one obsidian monolith per large coin, standing in a ring
 * on polished black stone around a sculpture of liquid gold in a golden
 * armillary. What it shows is read from the market (mapping.js): a monolith's
 * height is its coin's market cap, the light in its seam the last 24 hours, and
 * the gold ripples harder the more the whole ring moved.
 *
 * Point at a monolith on the Markets page to name its coin; click to open it.
 * Each page looks at the ring from its own place (mapping.js VIEWS); a coin's
 * page looks at that coin's monolith.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { NOISE, GLOW_POINTS_FRAG } from './glsl.js';
import { heightFor, gemFor, ripple, viewOf } from './mapping.js';

const RADIUS = 9.2;
const PLINTH = 0.08;

// The monolith's light: a seam down each broad face with pulses running up it,
// and a gold hairline framing the face. Shared by the monoliths and their reflections.
const SLAB_ATTRS = /* glsl */ `
attribute vec3 aGem; attribute float aHover; attribute float aOn; attribute float aSeed; attribute float aHeight;`;
const SLAB_VARYINGS = /* glsl */ `
varying vec3 vGem; varying float vHover; varying float vOn; varying float vSeed; varying float vHeight; varying vec3 vObj; varying vec3 vObjN;`;
const SLAB_PASS = /* glsl */ `
vGem = aGem; vHover = aHover; vOn = aOn; vSeed = aSeed; vHeight = aHeight; vObj = position; vObjN = normal;`;
const SLAB_GLOW = /* glsl */ `
vec3 slabGlow(float time) {
  float face = step(0.6, abs(vObjN.z));
  float lit = mix(0.12, 1.0, vOn);
  float y = (vObj.y + 0.5) * vHeight;
  float pulse = 0.5 + 0.5 * sin(y * 3.1 - time * 1.7 + vSeed * 6.2832);
  float seam = (1.0 - smoothstep(0.003, 0.016, abs(vObj.x))) * face;
  vec3 col = vGem * seam * (0.3 + 0.7 * pulse) * (1.0 + 2.8 * vHover) * lit;
  float ax = abs(vObj.x);
  float frameX = smoothstep(0.236, 0.243, ax) * (1.0 - smoothstep(0.249, 0.256, ax));
  float ey = abs(vObj.y) * vHeight;
  float top = vHeight * 0.5 - 0.075;
  float frameY = smoothstep(top - 0.008, top, ey) * (1.0 - smoothstep(top + 0.006, top + 0.014, ey));
  float inside = step(ax, 0.256) * step(ey, top + 0.014);
  col += vec3(0.95, 0.73, 0.4) * (frameX * step(ey, top + 0.014) + frameY * step(ax, 0.256)) * face * inside * 0.6 * mix(0.35, 1.0, vOn) * (1.0 + vHover);
  col += vGem * vHover * 0.1 * face;
  return col;
}`;

export function createRing({ envMap, quality, pixelRatio }, { coins, tip, money, pct }) {
  const q = quality();
  const scene = new THREE.Scene();
  const bg = new THREE.Color('#060607');
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 15, 46);
  scene.environment = envMap;
  scene.environmentIntensity = 0.65;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 160);
  const uTime = { value: 0 };
  const uAmp = { value: 0.12 };
  const gold = new THREE.Color('#d8b46e');

  // ---- where each monolith stands: largest first, the ring's front facing the opening view
  const caps = coins.map((c) => c.marketCap);
  const lo = Math.min(...caps), hi = Math.max(...caps);
  const items = coins.map((coin, i) => {
    const gem = gemFor(coin.change24h);
    let seed = 0;
    for (const ch of coin.symbol) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    return {
      coin,
      angle: 0.55 + ((i + 0.5) / coins.length) * Math.PI * 2,
      height: heightFor(coin.marketCap, lo, hi),
      heightTo: heightFor(coin.marketCap, lo, hi),
      seed: seed / 9973,
      color: new THREE.Color(gem.color),
      colorTo: new THREE.Color(gem.color),
      hover: 0,
      hoverTo: 0,
      on: gem.glow,
      onTo: gem.glow,
    };
  });
  const N = items.length;
  uAmp.value = ripple(coins.map((c) => c.change24h));

  // ---- monoliths, their reflections and their gold plinths
  const slabGeo = new RoundedBoxGeometry(0.62, 1, 0.17, 3, 0.035);
  const aGem = new Float32Array(N * 3);
  const aSeed = new Float32Array(N);
  const aHeight = new Float32Array(N);
  items.forEach((it, i) => {
    it.color.toArray(aGem, i * 3);
    aSeed[i] = it.seed;
    aHeight[i] = it.height;
  });
  const gemAttr = new THREE.InstancedBufferAttribute(aGem, 3).setUsage(THREE.DynamicDrawUsage);
  const heightAttr = new THREE.InstancedBufferAttribute(aHeight, 1).setUsage(THREE.DynamicDrawUsage);
  const hoverAttr = new THREE.InstancedBufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
  const onAttr = new THREE.InstancedBufferAttribute(new Float32Array(items.map((it) => it.on)), 1).setUsage(THREE.DynamicDrawUsage);
  slabGeo.setAttribute('aGem', gemAttr);
  slabGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  slabGeo.setAttribute('aHeight', heightAttr);
  slabGeo.setAttribute('aHover', hoverAttr);
  slabGeo.setAttribute('aOn', onAttr);

  const slabMat = new THREE.MeshPhysicalMaterial({
    color: 0x09090b, metalness: 0.25, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.14, envMapIntensity: 0.95,
  });
  slabMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SLAB_ATTRS}\n${SLAB_VARYINGS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SLAB_PASS}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\n${SLAB_VARYINGS}\n${SLAB_GLOW}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += slabGlow(uTime);');
  };

  const mirrorMat = new THREE.ShaderMaterial({
    uniforms: { uTime },
    vertexShader: /* glsl */ `
      ${SLAB_ATTRS}
      ${SLAB_VARYINGS}
      varying float vDepth;
      void main() {
        ${SLAB_PASS}
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      ${SLAB_VARYINGS}
      varying float vDepth;
      ${SLAB_GLOW}
      void main() {
        vec3 col = vec3(0.012) + slabGlow(uTime);
        gl_FragColor = vec4(col * exp(-vDepth * 0.85) * 0.85, 1.0);
        #include <colorspace_fragment>
      }`,
  });

  const goldMat = new THREE.MeshPhysicalMaterial({
    color: gold, metalness: 1, roughness: 0.24, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 1.45,
  });

  const slabs = new THREE.InstancedMesh(slabGeo, slabMat, N);
  const mirror = new THREE.InstancedMesh(slabGeo, mirrorMat, N);
  const plinths = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, PLINTH, 0.3), goldMat, N);
  for (const mesh of [slabs, mirror, plinths]) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(slabs, mirror, plinths);

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  function place(i) {
    const it = items[i];
    const lift = it.hover * 0.24;
    const x = Math.sin(it.angle) * RADIUS;
    const z = Math.cos(it.angle) * RADIUS;
    quat.setFromAxisAngle(UP, it.angle + Math.PI); // broad faces turned to the core
    pos.set(x, PLINTH + lift + it.height / 2, z);
    scl.set(1, it.height, 1);
    slabs.setMatrixAt(i, m4.compose(pos, quat, scl));
    pos.y = -pos.y;
    scl.y = -it.height;
    mirror.setMatrixAt(i, m4.compose(pos, quat, scl));
    pos.y = PLINTH / 2;
    scl.set(1, 1, 1);
    plinths.setMatrixAt(i, m4.compose(pos, quat, scl));
  }
  items.forEach((_, i) => place(i));
  slabs.computeBoundingSphere();

  // ---- polished black stone with inlaid gold rings; see-through enough to show the reflections
  const floorMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uGold: { value: gold }, uBg: { value: bg }, uRing: { value: RADIUS } },
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
      float ring(float r, float at, float px) { return 1.0 - smoothstep(0.0, px * 1.4, abs(r - at)); }
      void main() {
        float r = length(vWorld.xz);
        float px = fwidth(r);
        vec3 col = vec3(0.010, 0.0095, 0.0105);
        float lines = ring(r, uRing + 0.62, px) * 0.9 + ring(r, uRing - 0.62, px) * 0.9
                    + ring(r, 3.1, px) * 0.7 + ring(r, 4.6, px) * 0.4 + ring(r, uRing + 2.6, px) * 0.3;
        float ang = atan(vWorld.z, vWorld.x);
        float d = abs(fract(ang / 6.2831853 * 32.0 + 0.5) - 0.5) * 6.2831853 / 32.0 * r;
        float spoke = (1.0 - smoothstep(0.0, px * 1.4, d)) * step(3.1, r) * step(r, 4.6);
        col += uGold * (lines + spoke * 0.32) * 0.75;
        col += uGold * 0.1 * exp(-r * r / 7.0);
        float fade = smoothstep(30.0, 9.0, r);
        gl_FragColor = vec4(mix(uBg, col, fade), mix(1.0, 0.72, fade));
        #include <colorspace_fragment>
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---- the centrepiece: liquid gold on an obsidian pedestal, inside an armillary.
  // Its ripple (uAmp) is the market's: the ring's average 24-hour move.
  const coreGeo = new THREE.IcosahedronGeometry(1.12, q >= 2 ? 48 : 24);
  const coreMat = new THREE.MeshPhysicalMaterial({
    color: '#e9c47e', metalness: 1, roughness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.12, envMapIntensity: 1.35,
  });
  coreMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uAmp = uAmp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uAmp;
        ${NOISE}
        float field(vec3 n) {
          return snoise(n * 1.15 + vec3(0.0, uTime * 0.16, uTime * 0.09)) * uAmp
               + snoise(n * 2.6 - vec3(uTime * 0.12)) * uAmp * 0.28;
        }`)
      .replace('#include <beginnormal_vertex>', `
        vec3 nrm0 = normalize(position);
        float disp0 = field(nrm0);
        vec3 tng = normalize(cross(nrm0, abs(nrm0.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 btg = cross(nrm0, tng);
        vec3 nA = normalize(nrm0 + tng * 0.012);
        vec3 nB = normalize(nrm0 + btg * 0.012);
        vec3 pO = nrm0 * (1.0 + disp0);
        vec3 pA = nA * (1.0 + field(nA));
        vec3 pB = nB * (1.0 + field(nB));
        vec3 objectNormal = normalize(cross(pA - pO, pB - pO));`)
      .replace('#include <begin_vertex>', 'vec3 transformed = position * (1.0 + disp0);');
  };
  const core = new THREE.Mesh(coreGeo, coreMat);
  scene.add(core);

  const obsidian = new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0c, metalness: 0.2, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.2,
  });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.62, 0.36, 96), obsidian);
  pedestal.position.y = 0.18;
  const lip = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.03, 12, 160), goldMat);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.36;
  scene.add(pedestal, lip);

  const armillary = [1.7, 2.02, 2.34].map((r, i) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, i === 1 ? 0.022 : 0.014, 16, 200), goldMat);
    scene.add(ring);
    return ring;
  });

  // a soft shaft of light falling on the sculpture
  const beamMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color('#ffe2a8') } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vY = (position.y + 4.5) / 9.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float a = facing * pow(1.0 - vY, 1.3) * smoothstep(0.0, 0.08, vY) * 0.085;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(2.1, 9, 48, 1, true), beamMat);
  beam.position.y = 0.36 + 4.5;
  scene.add(beam);

  // ---- gold dust drifting through the room
  const DUST = q >= 2 ? 800 : q === 1 ? 420 : 220;
  const dustGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DUST * 3);
  const dSize = new Float32Array(DUST);
  const dSeed = new Float32Array(DUST);
  const dColor = new Float32Array(DUST * 3);
  const dustColor = new THREE.Color('#f0d39a');
  for (let i = 0; i < DUST; i += 1) {
    const r = Math.sqrt(Math.random()) * 17;
    const a = Math.random() * Math.PI * 2;
    dPos.set([Math.cos(a) * r, Math.random() * 9, Math.sin(a) * r], i * 3);
    dSize[i] = 0.6 + Math.random() * Math.random() * 2.6;
    dSeed[i] = Math.random();
    dustColor.toArray(dColor, i * 3);
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dSeed, 1));
  dustGeo.setAttribute('aColor', new THREE.BufferAttribute(dColor, 3));
  const dustMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime, uPR: { value: pixelRatio() }, uOpacity: { value: 0.5 } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aSeed; attribute vec3 aColor;
      uniform float uTime; uniform float uPR;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.07 + aSeed * 0.12), 9.0);
        p.x += sin(uTime * 0.21 + aSeed * 40.0) * 0.45;
        p.z += cos(uTime * 0.17 + aSeed * 31.0) * 0.45;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vColor = aColor;
        vAlpha = smoothstep(0.0, 1.2, p.y) * smoothstep(9.0, 7.0, p.y) * (0.55 + 0.45 * sin(uTime * 1.7 + aSeed * 60.0));
        gl_PointSize = aSize * uPR * (10.0 / max(-mv.z, 0.5));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLOW_POINTS_FRAG,
  });
  scene.add(new THREE.Points(dustGeo, dustMat));

  // ---- light
  const coreLight = new THREE.PointLight('#ffcf8a', 22, 0, 2);
  coreLight.position.set(0, 2.5, 0);
  const key = new THREE.DirectionalLight('#fff0d8', 0.7);
  key.position.set(4, 10, 6);
  scene.add(coreLight, key);

  // ---- the view: each page has its own; the Markets page orbits slowly
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const label = tipParts(tip);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, px: -1, py: -1, moved: false, inside: false };
  let width = 1;
  let height = 1;
  let orbit = 0;
  let hovered = null;
  let page = 'markets';
  let focus = null; // the coin a coin page looks at
  const eye = new THREE.Vector3();
  const look = new THREE.Vector3();
  const goalEye = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const fromEye = new THREE.Vector3();
  const fromLook = new THREE.Vector3();
  let glide = null;
  let placed = false;
  let sideWidth = 0;

  // The ring stands in the part of the screen the page leaves open: right of the
  // sidebar, and on the Markets page above its headline. Elsewhere it sits low,
  // behind the panels, so nothing bright stands behind a page's opening words.
  function frame() {
    const w = width, h = height;
    const wide = w / h > 1.15;
    camera.aspect = w / h;
    camera.fov = wide ? 33 : w / h < 0.8 ? 60 : 44;
    const home = page === 'markets';
    const x = -sideWidth / 2 - (wide ? w * (home ? 0.07 : 0.12) : 0);
    const y = home ? h * (wide ? 0.22 : 0.2) : -h * 0.04;
    camera.setViewOffset(w, h, x, y, w, h);
    camera.updateProjectionMatrix();
  }

  /** Where the camera should be for the page shown, at time `t`. */
  function goal(t) {
    const portrait = width / height < 0.9;
    if (focus) {
      const it = focus;
      const ix = Math.sin(it.angle) * RADIUS;
      const iz = Math.cos(it.angle) * RADIUS;
      // in front of the monolith, a little off its axis, looking up at its face
      const out = new THREE.Vector3(-ix, 0, -iz).normalize();
      const side = new THREE.Vector3(out.z, 0, -out.x);
      goalEye.set(ix, 0, iz).addScaledVector(out, portrait ? 4.2 : 3.1).addScaledVector(side, 0.9);
      goalEye.y = 1.5 + it.height * 0.32;
      goalLook.set(ix, PLINTH + it.height * 0.58, iz);
      return;
    }
    const v = viewOf(page);
    if (!v) {
      // the Markets page: the portfolio's opening orbit, nudged by the pointer
      const dist = portrait ? 30 : 28;
      const a = orbit + pointer.sx * 0.12;
      goalEye.set(Math.sin(a) * dist, 8.2 + pointer.sy * 0.8, Math.cos(a) * dist);
      goalLook.set(0, 1.1, 0);
      return;
    }
    const [a, dist, y, ty] = v;
    goalEye.set(Math.sin(a) * dist * (portrait ? 1.2 : 1), y, Math.cos(a) * dist * (portrait ? 1.2 : 1));
    goalLook.set(0, ty, 0);
  }

  function pick(x, y) {
    ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(slabs, false)[0];
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
    tipAt.set(Math.sin(hovered.angle) * RADIUS, PLINTH + hovered.height + 0.55, Math.cos(hovered.angle) * RADIUS).project(camera);
    const w = tip.offsetWidth || 200;
    const h = tip.offsetHeight || 80;
    const x = Math.min(Math.max((tipAt.x * 0.5 + 0.5) * width, w / 2 + 12), width - w / 2 - 12);
    const y = Math.max((-tipAt.y * 0.5 + 0.5) * height, h + 70);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  /**
   * One step of the world. Returns true while something is still moving that
   * needs another frame even with motion reduced (a glide, a hover easing).
   */
  function update(t, dt, now) {
    uTime.value = t;
    const follow = dt > 0 ? Math.min(1, dt * 3) : 1;
    pointer.sx += (pointer.x - pointer.sx) * follow;
    pointer.sy += (pointer.y - pointer.sy) * follow;
    orbit += dt * 0.03;

    goal(t);
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

    core.position.y = 2.45 + Math.sin(t * 0.7) * 0.08;
    core.rotation.y = t * 0.12;
    armillary[0].rotation.set(t * 0.21, 0.6, 0);
    armillary[1].rotation.set(1.15, t * 0.15, 0);
    armillary[2].rotation.set(Math.PI / 2 + Math.sin(t * 0.2) * 0.3, 0, t * 0.11);
    for (const ring of armillary) ring.position.y = core.position.y;

    if (pointer.moved) {
      pointer.moved = false;
      setHover(pointer.inside && !glide ? pick(pointer.px, pointer.py) : null);
    }

    const ease = dt > 0 ? Math.min(1, dt * 7) : 1;
    let moved = false;
    let lit = false;
    items.forEach((it, i) => {
      if (Math.abs(it.hoverTo - it.hover) > 0.001 || Math.abs(it.heightTo - it.height) > 0.001) {
        it.hover += (it.hoverTo - it.hover) * ease;
        it.height += (it.heightTo - it.height) * ease;
        hoverAttr.array[i] = it.hover;
        heightAttr.array[i] = it.height;
        place(i);
        moved = true;
      }
      if (Math.abs(it.onTo - it.on) > 0.001 || !it.color.equals(it.colorTo)) {
        it.on += (it.onTo - it.on) * ease;
        it.color.lerp(it.colorTo, ease);
        if (Math.abs(it.color.r - it.colorTo.r) + Math.abs(it.color.g - it.colorTo.g) + Math.abs(it.color.b - it.colorTo.b) < 0.003) it.color.copy(it.colorTo);
        onAttr.array[i] = it.on;
        it.color.toArray(gemAttr.array, i * 3);
        lit = true;
      }
    });
    if (moved) {
      hoverAttr.needsUpdate = true;
      heightAttr.needsUpdate = true;
      for (const mesh of [slabs, mirror, plinths]) mesh.instanceMatrix.needsUpdate = true;
      slabs.computeBoundingSphere();
    }
    if (lit) {
      onAttr.needsUpdate = true;
      gemAttr.needsUpdate = true;
    }
    placeTip();
    return Boolean(glide) || moved || lit;
  }

  return {
    scene,
    camera,
    update,
    get gliding() { return Boolean(glide); },
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
      focus = sym ? items.find((it) => it.coin.symbol.toUpperCase() === sym) || null : null;
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
    /** New readings: a coin's cap sets its height, its 24-hour move its light. */
    setCoins(list) {
      const by = new Map(list.map((c) => [String(c.symbol).toUpperCase(), c]));
      const fresh = items.map((it) => by.get(it.coin.symbol.toUpperCase())).filter(Boolean);
      const capsNow = fresh.map((c) => c.marketCap).filter((x) => x > 0);
      const lo2 = capsNow.length ? Math.min(...capsNow) : lo;
      const hi2 = capsNow.length ? Math.max(...capsNow) : hi;
      for (const it of items) {
        const c = by.get(it.coin.symbol.toUpperCase());
        if (!c) continue;
        it.coin = { ...it.coin, ...c };
        if (c.marketCap > 0) it.heightTo = heightFor(c.marketCap, lo2, hi2);
        const gem = gemFor(it.coin.change24h);
        it.colorTo.set(gem.color);
        it.onTo = gem.glow;
      }
      uAmp.value = ripple(items.map((it) => it.coin.change24h));
    },
    /** A live 24-hour move for one coin (from the exchange's stream). */
    setChange(symbol, change, price) {
      const it = items.find((x) => x.coin.symbol.toUpperCase() === symbol);
      if (!it || !Number.isFinite(change)) return false;
      it.coin = { ...it.coin, change24h: change, ...(Number.isFinite(price) ? { price } : {}) };
      const gem = gemFor(change);
      const changed = !it.colorTo.equals(new THREE.Color(gem.color)) || Math.abs(it.onTo - gem.glow) > 0.02;
      it.colorTo.set(gem.color);
      it.onTo = gem.glow;
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
    /** The hover label goes when the page changes or the pointer leaves the world. */
    clearHover() {
      setHover(null);
    },
  };
}

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
