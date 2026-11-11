import * as THREE from 'three';
import { Clip, createClip, setFramePos, setFrameQuat } from './clip';
import { Skeleton } from './skeleton';

export const BONE = {
  Root: 0,
  Hips: 1,
  Spine: 2,
  Head: 3,
  UpperLegL: 4,
  LowerLegL: 5,
  FootL: 6,
  UpperLegR: 7,
  LowerLegR: 8,
  FootR: 9,
  ArmL: 10,
  ForearmL: 11,
  ArmR: 12,
  ForearmR: 13,
} as const;

const REST: Record<string, [number, number, number]> = {
  Root: [0, 0, 0],
  Hips: [0, 0.95, 0],
  Spine: [0, 0.3, 0],
  Head: [0, 0.38, 0],
  UpperLegL: [0.1, 0, 0],
  LowerLegL: [0, -0.45, 0],
  FootL: [0, -0.45, 0],
  UpperLegR: [-0.1, 0, 0],
  LowerLegR: [0, -0.45, 0],
  FootR: [0, -0.45, 0],
  ArmL: [0.22, 0.28, 0],
  ForearmL: [0.3, 0, 0],
  ArmR: [-0.22, 0.28, 0],
  ForearmR: [-0.3, 0, 0],
};

export function buildSkeleton(): Skeleton {
  const parentOf: Record<string, number> = {
    Root: -1,
    Hips: BONE.Root,
    Spine: BONE.Hips,
    Head: BONE.Spine,
    UpperLegL: BONE.Hips,
    LowerLegL: BONE.UpperLegL,
    FootL: BONE.LowerLegL,
    UpperLegR: BONE.Hips,
    LowerLegR: BONE.UpperLegR,
    FootR: BONE.LowerLegR,
    ArmL: BONE.Spine,
    ForearmL: BONE.ArmL,
    ArmR: BONE.Spine,
    ForearmR: BONE.ArmR,
  };
  const names = Object.keys(REST);
  return {
    rootIndex: BONE.Root,
    bones: names.map((name) => ({
      name,
      parent: parentOf[name],
      restPos: REST[name],
    })),
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ARM_HANG_L = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -Math.PI / 2);
const ARM_HANG_R = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2);

interface WalkFrame {
  rootPos: THREE.Vector3;
  rootYaw: number;
  phase: number; // 步态相位（由累计弧长驱动，倒退时相位反向）
}

const LEG_SWING = 0.55;
const KNEE_BEND = 1.0;
const ARM_SWING = 0.4;

function writeWalkFrame(clip: Clip, frame: number, w: WalkFrame): void {
  const phi = w.phase;
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const rest = (name: string) => new THREE.Vector3(...(REST[name] as [number, number, number]));

  setFramePos(clip, BONE.Root, frame, w.rootPos);
  setFrameQuat(clip, BONE.Root, frame, q.setFromAxisAngle(UP, w.rootYaw));

  const bob = 0.04 * (0.5 - 0.5 * Math.cos(2 * phi));
  setFramePos(clip, BONE.Hips, frame, rest('Hips').add(new THREE.Vector3(0.02 * Math.sin(phi), -bob, 0)));
  setFrameQuat(clip, BONE.Hips, frame, q.setFromAxisAngle(UP, 0.08 * Math.sin(phi)));

  setFramePos(clip, BONE.Spine, frame, rest('Spine'));
  setFrameQuat(clip, BONE.Spine, frame, q.setFromAxisAngle(UP, -0.06 * Math.sin(phi)));

  setFramePos(clip, BONE.Head, frame, rest('Head'));
  setFrameQuat(clip, BONE.Head, frame, q.identity());

  const swingL = -LEG_SWING * Math.sin(phi);
  const swingR = LEG_SWING * Math.sin(phi);
  const kneeL = KNEE_BEND * Math.max(0, Math.cos(phi));
  const kneeR = KNEE_BEND * Math.max(0, -Math.cos(phi));

  setFramePos(clip, BONE.UpperLegL, frame, rest('UpperLegL'));
  setFrameQuat(clip, BONE.UpperLegL, frame, q.setFromAxisAngle(X_AXIS, swingL));
  setFramePos(clip, BONE.LowerLegL, frame, rest('LowerLegL'));
  setFrameQuat(clip, BONE.LowerLegL, frame, q.setFromAxisAngle(X_AXIS, kneeL));
  setFramePos(clip, BONE.FootL, frame, rest('FootL'));
  setFrameQuat(clip, BONE.FootL, frame, q.identity());

  setFramePos(clip, BONE.UpperLegR, frame, rest('UpperLegR'));
  setFrameQuat(clip, BONE.UpperLegR, frame, q.setFromAxisAngle(X_AXIS, swingR));
  setFramePos(clip, BONE.LowerLegR, frame, rest('LowerLegR'));
  setFrameQuat(clip, BONE.LowerLegR, frame, q.setFromAxisAngle(X_AXIS, kneeR));
  setFramePos(clip, BONE.FootR, frame, rest('FootR'));
  setFrameQuat(clip, BONE.FootR, frame, q.identity());

  setFramePos(clip, BONE.ArmL, frame, rest('ArmL'));
  q.setFromAxisAngle(X_AXIS, ARM_SWING * Math.sin(phi)).multiply(ARM_HANG_L);
  setFrameQuat(clip, BONE.ArmL, frame, q);
  setFramePos(clip, BONE.ForearmL, frame, rest('ForearmL'));
  setFrameQuat(clip, BONE.ForearmL, frame, q2.identity());

  setFramePos(clip, BONE.ArmR, frame, rest('ArmR'));
  q.setFromAxisAngle(X_AXIS, -ARM_SWING * Math.sin(phi)).multiply(ARM_HANG_R);
  setFrameQuat(clip, BONE.ArmR, frame, q);
  setFramePos(clip, BONE.ForearmR, frame, rest('ForearmR'));
  setFrameQuat(clip, BONE.ForearmR, frame, q2.identity());
}

/** 直行：匀速 1.4 m/s 向 +Z，步幅 1.4 m，4 s 整 4 步，循环无缝。 */
export function makeStraightClip(skel: Skeleton): Clip {
  const fps = 30;
  const duration = 4;
  const v = 1.4;
  const stride = 1.4;
  const clip = createClip('直行', duration, fps, skel.bones.length);
  for (let i = 0; i < clip.frameCount; i++) {
    const t = i / fps;
    const s = v * t;
    writeWalkFrame(clip, i, {
      rootPos: new THREE.Vector3(0, 0, s),
      rootYaw: 0,
      phase: (2 * Math.PI * s) / stride,
    });
  }
  return clip;
}

/** 转弯：半径 1 m 的圆弧，角速度 π/2 rad/s，4.5 s 累计 405°（超过一整圈，验证角度连续累积）。 */
export function makeTurnClip(skel: Skeleton): Clip {
  const fps = 30;
  const duration = 4.5;
  const radius = 1.0;
  const omega = Math.PI / 2;
  const totalArc = omega * radius * duration;
  const stride = totalArc / 5; // 整 5 步，循环无缝
  const clip = createClip('转弯', duration, fps, skel.bones.length);
  for (let i = 0; i < clip.frameCount; i++) {
    const t = i / fps;
    const theta = omega * t;
    writeWalkFrame(clip, i, {
      rootPos: new THREE.Vector3(radius * (1 - Math.cos(theta)), 0, radius * Math.sin(theta)),
      rootYaw: theta,
      phase: (2 * Math.PI * radius * theta) / stride,
    });
  }
  return clip;
}

/** 前后不对称：前进 1.8 m/s × 2 s，停 1 s，后退 0.4 m/s × 2 s，净位移 +2.8 m。 */
export function makeAsymmetricClip(skel: Skeleton): Clip {
  const fps = 30;
  const duration = 5;
  const stride = 1.4;
  const arcLength = (t: number): number => {
    if (t < 2) return 1.8 * t;
    if (t < 3) return 3.6;
    return 3.6 - 0.4 * (t - 3);
  };
  const clip = createClip('前后不对称', duration, fps, skel.bones.length);
  for (let i = 0; i < clip.frameCount; i++) {
    const t = i / fps;
    const s = arcLength(t);
    writeWalkFrame(clip, i, {
      rootPos: new THREE.Vector3(0, 0, s),
      rootYaw: 0,
      phase: (2 * Math.PI * s) / stride,
    });
  }
  return clip;
}

export const CLIP_BUILDERS: Record<string, (skel: Skeleton) => Clip> = {
  straight: makeStraightClip,
  turn: makeTurnClip,
  asymmetric: makeAsymmetricClip,
};
