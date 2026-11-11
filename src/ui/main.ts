import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Clip } from '../core/clip';
import { originalWorldPoseAt, recombineErrorAt } from '../core/compare';
import { extractRootMotion } from '../core/extract';
import { Player } from '../core/player';
import { exportScene, importScene } from '../core/serialize';
import { Skeleton, WorldPose } from '../core/skeleton';
import { CLIP_BUILDERS, buildSkeleton } from '../core/testClips';

interface SceneState {
  skel: Skeleton;
  original: Clip | null;
  player: Player;
  clipName: string;
}

// ---------- 骨架可视化 ----------

class SkeletonView {
  readonly group = new THREE.Group();
  private joints: THREE.Mesh[] = [];
  private linePositions: Float32Array;
  private lineGeom: THREE.BufferGeometry;
  private bonePairs: [number, number][] = [];

  constructor(skel: Skeleton, color: THREE.ColorRepresentation, opacity = 1) {
    const transparent = opacity < 1;
    const jointGeom = new THREE.SphereGeometry(0.04, 12, 8);
    const jointMat = new THREE.MeshStandardMaterial({ color, transparent, opacity });
    for (const bone of skel.bones) {
      const mesh = new THREE.Mesh(jointGeom, jointMat);
      this.joints.push(mesh);
      this.group.add(mesh);
      if (bone.parent >= 0) this.bonePairs.push([bone.parent, skel.bones.indexOf(bone)]);
    }
    this.linePositions = new Float32Array(this.bonePairs.length * 6);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color, transparent, opacity });
    this.group.add(new THREE.LineSegments(this.lineGeom, lineMat));
  }

  update(world: WorldPose): void {
    for (let i = 0; i < this.joints.length; i++) {
      this.joints[i].position.copy(world.pos[i]);
    }
    this.bonePairs.forEach(([parent, child], k) => {
      const a = world.pos[parent];
      const b = world.pos[child];
      this.linePositions.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
    });
    this.lineGeom.attributes.position.needsUpdate = true;
    this.lineGeom.computeBoundingSphere();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}

// ---------- 场景 ----------

const viewport = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.fog = new THREE.Fog(0x14171c, 18, 40);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
camera.position.set(3.5, 2.6, -3.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 2.2);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f38, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 8, 3);
scene.add(sun);

const grid = new THREE.GridHelper(24, 24, 0x3a4452, 0x262d37);
scene.add(grid);
scene.add(new THREE.AxesHelper(0.6));

// 轨迹线 + 循环标记 + 当前位置/朝向
const trajGeom = new THREE.BufferGeometry();
const trajLine = new THREE.Line(
  trajGeom,
  new THREE.LineBasicMaterial({ color: 0x4aa3ff }),
);
trajLine.frustumCulled = false;
scene.add(trajLine);

const cycleMarkers = new THREE.Group();
scene.add(cycleMarkers);

const rootMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 16, 12),
  new THREE.MeshStandardMaterial({ color: 0xffc14a }),
);
scene.add(rootMarker);

const headingArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(),
  0.7,
  0xffc14a,
  0.18,
  0.1,
);
scene.add(headingArrow);

// ---------- 状态 ----------

let state: SceneState;
let recombinedView: SkeletonView | null = null;
let ghostView: SkeletonView | null = null;
let baseSpeed = 1;
let reverse = false;
let seeking = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setState(next: SceneState): void {
  state = next;
  recombinedView?.dispose();
  ghostView?.dispose();
  recombinedView = new SkeletonView(state.skel, 0x53d769);
  scene.add(recombinedView.group);
  if (state.original) {
    ghostView = new SkeletonView(state.skel, 0xff5a5a, 0.55);
    scene.add(ghostView.group);
  }
  $('seekRange').setAttribute('max', state.player.duration.toString());
  rebuildTrajectoryLine();
  updateGhostVisibility();
  $('dataStatus').textContent = state.original
    ? `当前片段：${state.clipName}`
    : `已导入：${state.clipName}（无原始动画，对比不可用）`;
}

function loadClip(key: string): void {
  const skel = buildSkeleton();
  const original = CLIP_BUILDERS[key](skel);
  const { trajectory, inPlace } = extractRootMotion(skel, original);
  const player = new Player(skel, inPlace, trajectory);
  player.playing = true;
  player.speed = reverse ? -baseSpeed : baseSpeed;
  player.loop = $<HTMLInputElement>('loopChk').checked;
  setState({ skel, original, player, clipName: original.name });
}

function rebuildTrajectoryLine(): void {
  const { player } = state;
  const T = player.duration;
  const cycles = player.loop ? 3 : 1;
  const pts = player.trajectory.bakePoints(0, T * cycles, T / 60, player.loop);
  trajGeom.setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y + 0.02, p.z)));
  cycleMarkers.clear();
  const markerGeom = new THREE.SphereGeometry(0.05, 10, 8);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x4aa3ff });
  for (let k = 0; k <= cycles; k++) {
    const f = player.trajectory.evaluate(T * k, player.loop);
    const m = new THREE.Mesh(markerGeom, markerMat);
    m.position.set(f.x, f.y + 0.02, f.z);
    cycleMarkers.add(m);
  }
}

// ---------- 控件 ----------

$('clipSelect').addEventListener('change', (e) => {
  loadClip((e.target as HTMLSelectElement).value);
});

$('playBtn').addEventListener('click', () => {
  state.player.playing = !state.player.playing;
  $('playBtn').textContent = state.player.playing ? '暂停' : '播放';
});

$<HTMLInputElement>('reverseChk').addEventListener('change', (e) => {
  reverse = (e.target as HTMLInputElement).checked;
  state.player.speed = reverse ? -baseSpeed : baseSpeed;
});

$<HTMLInputElement>('loopChk').addEventListener('change', (e) => {
  state.player.loop = (e.target as HTMLInputElement).checked;
  rebuildTrajectoryLine();
});

$<HTMLInputElement>('speedRange').addEventListener('input', (e) => {
  baseSpeed = parseFloat((e.target as HTMLInputElement).value);
  $('speedVal').textContent = `${baseSpeed.toFixed(2)}×`;
  state.player.speed = reverse ? -baseSpeed : baseSpeed;
});

const seekRange = $<HTMLInputElement>('seekRange');
seekRange.addEventListener('pointerdown', () => (seeking = true));
seekRange.addEventListener('pointerup', () => (seeking = false));
seekRange.addEventListener('input', () => {
  state.player.setTime(parseFloat(seekRange.value));
});

$('prevCycleBtn').addEventListener('click', () => {
  state.player.setTime(state.player.time - state.player.duration);
});
$('nextCycleBtn').addEventListener('click', () => {
  state.player.setTime(state.player.time + state.player.duration);
});

$<HTMLInputElement>('ghostChk').addEventListener('change', updateGhostVisibility);
function updateGhostVisibility(): void {
  const show = $<HTMLInputElement>('ghostChk').checked && !!state.original;
  ghostView?.group.traverse((obj) => (obj.visible = show));
}

$('exportBtn').addEventListener('click', () => {
  const json = exportScene(state.player, state.clipName);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blocking-previs-${state.clipName}.json`;
  a.click();
  URL.revokeObjectURL(url);
  $('dataStatus').textContent = `已导出 ${state.clipName}（${(json.length / 1024).toFixed(0)} KB）`;
});

$('importBtn').addEventListener('click', () => $<HTMLInputElement>('fileInput').click());
$<HTMLInputElement>('fileInput').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const { skel, player, clipName } = importScene(await file.text());
    player.playing = true;
    player.speed = reverse ? -baseSpeed : baseSpeed;
    setState({ skel, original: null, player, clipName });
  } catch (err) {
    $('dataStatus').textContent = `载入失败：${(err as Error).message}`;
  }
  (e.target as HTMLInputElement).value = '';
});

// ---------- HUD ----------

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits);
}

function updateHud(): void {
  const { player } = state;
  const t = player.time;
  const T = player.duration;
  const cycle = Math.floor(t / T);
  $('timeVal').textContent = `t=${t.toFixed(2)}s · 第${cycle + 1}循环`;

  const f = player.rootFrameAt(t);
  $('posX').textContent = `${fmt(f.x)} m`;
  $('posY').textContent = `${fmt(f.y)} m`;
  $('posZ').textContent = `${fmt(f.z)} m`;
  $('yawVal').textContent = `${fmt((f.yaw * 180) / Math.PI, 1)}°`;

  const rate = player.rootMotionRateAt(t);
  $('trajSpeed').textContent = `${fmt(rate.speed, 2)} m/s`;
  $('effSpeed').textContent = `${fmt(rate.speed * Math.abs(player.speed), 2)} m/s`;
  $('yawRate').textContent = `${fmt((rate.yawRate * 180) / Math.PI, 1)} °/s`;

  if (state.original) {
    const err = recombineErrorAt(state.skel, state.original, player, t);
    $('errVal').textContent = `${(err * 1000).toFixed(3)} mm`;
    const recombinedRoot = player.rootFrameAt(t);
    const ghost = originalWorldPoseAt(state.skel, state.original, t, player.loop);
    const rootErr = ghost.pos[state.skel.rootIndex];
    const dr = Math.hypot(recombinedRoot.x - rootErr.x, recombinedRoot.z - rootErr.z);
    $('pathErrVal').textContent = `${(dr * 1000).toFixed(3)} mm`;
  } else {
    $('errVal').textContent = '—';
    $('pathErrVal').textContent = '—';
  }

  if (!seeking) seekRange.value = String(player.localTime(t));
}

// ---------- 主循环 ----------

function resize(): void {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const clock = new THREE.Clock();
function tick(): void {
  const dt = Math.min(clock.getDelta(), 0.1);
  state.player.advance(dt);

  const world = state.player.worldPoseAt(state.player.time);
  recombinedView!.update(world);

  if (state.original && ghostView) {
    ghostView.update(originalWorldPoseAt(state.skel, state.original, state.player.time, state.player.loop));
  }

  const f = state.player.rootFrameAt(state.player.time);
  rootMarker.position.set(f.x, f.y + 0.02, f.z);
  headingArrow.position.set(f.x, f.y + 0.05, f.z);
  headingArrow.setDirection(new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)));

  if ($<HTMLInputElement>('followChk').checked) {
    const delta = new THREE.Vector3(f.x, 0, f.z).sub(new THREE.Vector3(controls.target.x, 0, controls.target.z));
    controls.target.set(f.x, 0.9, f.z);
    camera.position.add(delta);
  }

  updateHud();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

loadClip('straight');
resize();
tick();
