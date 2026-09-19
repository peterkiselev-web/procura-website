/* Procura station, rendered from assets/models/procura-station.glb.
   Two modes:
   - [data-station="scroll"]  pinned behind the home page panels; scroll drives rotation and position.
   - [data-station="viewer"]  self-contained turntable on the machines page; drag to rotate. */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MODEL_URL = "assets/models/procura-station.glb";
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let modelPromise = null;
function loadModel() {
  if (!modelPromise) {
    modelPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      window.dispatchEvent(new Event("procura:model-ready"));
      return gltf.scene;
    });
  }
  return modelPromise;
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (e) { return false; }
}

function buildScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.4;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
  camera.position.set(0, 0.02, 1.55);

  // The shell is near black, so rim lights do the work of separating it from the page.
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(1.2, 1.4, 1.6);
  const rimL = new THREE.SpotLight(0xf5f2ea, 14, 6, Math.PI / 5, 0.6);
  rimL.position.set(-1.4, 0.9, -1.2);
  const rimR = new THREE.SpotLight(0xffffff, 10, 6, Math.PI / 5, 0.6);
  rimR.position.set(1.5, 0.3, -1.0);
  const fill = new THREE.HemisphereLight(0xffffff, 0x111111, 0.25);
  scene.add(key, rimL, rimR, fill);

  // Soft contact shadow
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(0,0,0,0.75)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.42),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.221;

  const rig = new THREE.Group();   // moved by scroll
  const spin = new THREE.Group();  // rotated by scroll / drag
  rig.add(spin, shadow);
  scene.add(rig);

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(host);

  return { renderer, scene, camera, rig, spin, shadow, resize };
}

const MODEL_HEIGHT = 0.44;
function prepModel(model) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m && "envMapIntensity" in m) m.envMapIntensity = 0.8;
  });
  // The file's origin sits at the base plate. Centre it and normalise its height
  // so the scroll keyframes stay valid if the model file is replaced.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const k = MODEL_HEIGHT / size.y;
  const wrapper = new THREE.Group();
  model.position.sub(centre);
  wrapper.add(model);
  wrapper.scale.setScalar(k);
  return wrapper;
}

/* ---------------- Home: pinned, scroll driven ---------------- */
async function initScroll(host) {
  const stage = host.closest(".stage");
  if (!webglAvailable()) { stage && stage.classList.add("no-webgl"); return; }
  let s;
  try { s = buildScene(host); } catch (e) { stage && stage.classList.add("no-webgl"); return; }

  let model;
  try { model = prepModel((await loadModel()).clone()); }
  catch (e) { stage && stage.classList.add("no-webgl"); s.renderer.domElement.remove(); return; }
  s.spin.add(model);

  const gsap = window.gsap;
  const ST = window.ScrollTrigger;
  const isMobile = () => window.innerWidth < 900;

  // Half the visible width at the model's depth, so positions track the viewport.
  const halfW = () => Math.tan(THREE.MathUtils.degToRad(s.camera.fov / 2)) * s.camera.position.z * s.camera.aspect;

  // Keyframes per panel: x as a fraction of half width, y, rotation, scale.
  const frames = [
    { x: 0.52, y: 0.0, ry: -0.55, rx: 0.08, sc: 0.9 },   // hero
    { x: 0.46, y: 0.0, ry: 0.5, rx: 0.02, sc: 1.05 },     // £0 panel (copy left)
    { x: -0.46, y: 0.0, ry: -2.6, rx: 0.02, sc: 1.05 },   // cables panel (copy right)
    { x: 0.44, y: -0.03, ry: 0.0, rx: -0.06, sc: 1.25 },  // your brand (copy left), face on
  ];
  const mobileFrames = [
    { x: 0, y: 0.25, ry: -0.5, rx: 0.08, sc: 0.5 },
    { x: 0, y: 0.23, ry: 0.5, rx: 0.02, sc: 0.55 },
    { x: 0, y: 0.23, ry: -2.6, rx: 0.02, sc: 0.55 },
    { x: 0, y: 0.22, ry: 0.0, rx: -0.06, sc: 0.62 },
  ];

  const state = { ...frames[0] };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener("pointermove", (e) => {
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  // Entry: rise and spin in once the intro finishes.
  s.rig.position.y = -0.5;
  s.spin.rotation.y = -3.2;
  const intro = { y: -0.5, r: -3.2 };
  const runIntro = () => gsap.to(intro, { y: 0, r: 0, duration: reduce ? 0 : 2.2, ease: "expo.out", delay: 0.2 });
  if (document.body.classList.contains("is-loading")) {
    const obs = new MutationObserver(() => { if (!document.body.classList.contains("is-loading")) { obs.disconnect(); runIntro(); } });
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  } else runIntro();

  let tl = null;
  function buildTimeline() {
    if (tl) { tl.scrollTrigger && tl.scrollTrigger.kill(); tl.kill(); }
    const f = isMobile() ? mobileFrames : frames;
    Object.assign(state, f[0]);
    if (!ST) return;
    tl = gsap.timeline({
      scrollTrigger: { trigger: stage, start: "top top", end: "bottom bottom", scrub: 1.2 },
      defaults: { ease: "power2.inOut", duration: 1 },
    });
    for (let i = 1; i < f.length; i++) tl.to(state, f[i]);
  }
  buildTimeline();
  let lastMobile = isMobile();
  window.addEventListener("resize", () => { if (isMobile() !== lastMobile) { lastMobile = isMobile(); buildTimeline(); ST && ST.refresh(); } });

  // Render only while the stage is on screen.
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);

  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    if (!visible) return;
    const t = clock.getElapsedTime();
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    const float = reduce ? 0 : Math.sin(t * 0.9) * 0.006;
    s.rig.position.set(state.x * halfW(), state.y + intro.y + float, 0);
    s.rig.scale.setScalar(state.sc);
    s.spin.rotation.set(state.rx + pointer.y * 0.05, state.ry + intro.r + pointer.x * 0.12, 0);
    s.renderer.render(s.scene, s.camera);
  })();
}

/* ---------------- Machines page: drag to rotate ---------------- */
async function initViewer(host) {
  if (!webglAvailable()) { host.classList.add("no-webgl"); return; }
  let s;
  try { s = buildScene(host); } catch (e) { host.classList.add("no-webgl"); return; }
  let model;
  try { model = prepModel((await loadModel()).clone()); }
  catch (e) { host.classList.add("no-webgl"); s.renderer.domElement.remove(); return; }
  s.spin.add(model);
  s.camera.position.set(0, 0.03, 1.35);
  host.classList.add("is-ready");

  let rot = -0.5, vel = 0, dragging = false, lastX = 0, idle = 0;
  const el = s.renderer.domElement;
  el.style.touchAction = "pan-y";
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointermove", (e) => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; vel = dx * 0.008; rot += vel; idle = 0; });
  const up = () => { dragging = false; el.style.cursor = "grab"; };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(host);
  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    if (!visible) return;
    const dt = clock.getDelta();
    idle += dt;
    if (!dragging) { vel *= 0.94; rot += vel; if (idle > 1.5 && !reduce) rot += dt * 0.35; }
    s.spin.rotation.set(0.05, rot, 0);
    s.renderer.render(s.scene, s.camera);
  })();
}

document.querySelectorAll("[data-station]").forEach((host) => {
  (host.dataset.station === "viewer" ? initViewer : initScroll)(host);
});
