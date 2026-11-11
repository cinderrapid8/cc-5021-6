import { CamSpec, Camera, FrameBuffer, Rgb, rgb } from './render';

/** 舞台俯视/透视场景绘制：网格、舞台边界、标记、轨迹、骨架与 HUD。 */

const COLOR = {
  bg: rgb(0x14171c),
  grid: rgb(0x232a34),
  border: rgb(0x3a4452),
  trajIdle: rgb(0x2c4a66),
  skeleton: rgb(0x53d769),
  joint: rgb(0x7fe89a),
  root: rgb(0xffc14a),
  mark: rgb(0xd8dee9),
  markTarget: rgb(0xffc14a),
  text: rgb(0xe6edf3),
  dim: rgb(0x8b98a9),
};

type V3 = [number, number, number];

export interface StageMarkDraw {
  pos: V3;
  label: string;
  target: boolean;
}

export interface TrajDraw {
  pts: V3[];
  color: Rgb;
  active: boolean;
}

export interface StageFrameInput {
  camera: CamSpec;
  /** [宽(x), 深(z)]：x ∈ [-w/2, w/2]，z ∈ [0, d] */
  stageSize: [number, number];
  marks: StageMarkDraw[];
  trajectories: TrajDraw[];
  boneLines: [V3, V3][];
  joints: V3[];
  root: { pos: V3; yaw: number };
  hud: string[];
  /** 存在时绘制标题卡（覆盖场景） */
  titleCard?: string[];
}

function drawMark(fb: FrameBuffer, cam: Camera, mark: StageMarkDraw): void {
  const color = mark.target ? COLOR.markTarget : COLOR.mark;
  const [x, , z] = mark.pos;
  const circle: V3[] = [];
  const r = mark.target ? 0.28 : 0.2;
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    circle.push([x + r * Math.cos(a), 0.01, z + r * Math.sin(a)]);
  }
  cam.polyline(fb, circle, color);
  cam.polyline(fb, [[x - 0.32, 0.01, z], [x + 0.32, 0.01, z]], color);
  cam.polyline(fb, [[x, 0.01, z - 0.32], [x, 0.01, z + 0.32]], color);
  const labelPos = cam.project([x, 0.42, z]);
  if (labelPos) {
    fb.text(labelPos[0] - (mark.label.length * 6 - 1) / 2, labelPos[1] - 3, mark.label, color);
  }
}

export function renderStageFrame(fb: FrameBuffer, input: StageFrameInput): void {
  fb.clear(COLOR.bg);

  if (input.titleCard) {
    const scale = 2;
    const lineH = 9 * scale;
    const total = input.titleCard.length * lineH;
    input.titleCard.forEach((line, i) => {
      fb.textCentered((fb.height - total) / 2 + i * lineH, line, i === 0 ? COLOR.root : COLOR.text, scale);
    });
    return;
  }

  const cam = new Camera(input.camera, fb.width, fb.height);
  const [w, d] = input.stageSize;
  const x0 = -w / 2;
  const x1 = w / 2;

  for (let gx = Math.ceil(x0); gx <= Math.floor(x1); gx++) {
    cam.polyline(fb, [[gx, 0, 0], [gx, 0, d]], COLOR.grid);
  }
  for (let gz = 0; gz <= d; gz++) {
    cam.polyline(fb, [[x0, 0, gz], [x1, 0, gz]], COLOR.grid);
  }
  cam.polyline(fb, [[x0, 0, 0], [x1, 0, 0], [x1, 0, d], [x0, 0, d], [x0, 0, 0]], COLOR.border);

  for (const traj of input.trajectories) {
    cam.polyline(fb, traj.pts, traj.active ? traj.color : COLOR.trajIdle);
    if (traj.active && traj.pts.length > 0) {
      const end = cam.project(traj.pts[traj.pts.length - 1]);
      if (end) fb.fillCircle(end[0], end[1], 2, traj.color);
    }
  }

  for (const mark of input.marks) drawMark(fb, cam, mark);

  for (const [a, b] of input.boneLines) {
    const pa = cam.project(a);
    const pb = cam.project(b);
    if (pa && pb) fb.line(pa[0], pa[1], pb[0], pb[1], COLOR.skeleton);
  }
  for (const j of input.joints) {
    const p = cam.project(j);
    if (p) fb.fillCircle(p[0], p[1], 2, COLOR.joint);
  }

  const rootP = cam.project([input.root.pos[0], input.root.pos[1] + 0.02, input.root.pos[2]]);
  if (rootP) fb.fillCircle(rootP[0], rootP[1], 3, COLOR.root);
  cam.polyline(
    fb,
    [
      [input.root.pos[0], 0.05, input.root.pos[2]],
      [input.root.pos[0] + 0.5 * Math.sin(input.root.yaw), 0.05, input.root.pos[2] + 0.5 * Math.cos(input.root.yaw)],
    ],
    COLOR.root,
  );

  input.hud.forEach((line, i) => {
    fb.text(6, 6 + i * 9, line, i === 0 ? COLOR.dim : COLOR.text);
  });
}
