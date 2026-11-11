import * as THREE from 'three';
import { Clip, createClip, setFramePos, setFrameQuat } from '../core/clip';
import { Skeleton } from '../core/skeleton';
import { BONE } from '../core/testClips';

/**
 * 走位编排：把舞台调度动作（直行 / 转向 / 停步）编译成均匀采样动画片段。
 * 编译结果完全确定（动作时长量化到整帧、路径端点精确落位），
 * 同一参数重编译必得同一片段 —— 这是素材可重建核验的基础。
 */

export type Move =
  | { type: 'walkTo'; to: [number, number]; speed: number }
  | {
      type: 'turnTo';
      yawDeg?: number;
      headingTo?: [number, number];
      yawRateDeg: number;
      direction: 'cw' | 'ccw';
    }
  | { type: 'wait'; duration: number };

export interface SegmentChoreography {
  start: { pos: [number, number, number]; yawDeg: number };
  moves: Move[];
  /** 根位移缩放（对照片段用）：1 为正常；0.5 表示根只走一半路程（脚步打滑效果）。 */
  rootScale: number;
}

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const STRIDE_M = 1.4;

const mod2pi = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const wrapPi = (a: number): number => mod2pi(a + Math.PI) - Math.PI;
const smooth = (u: number): number => u * u * (3 - 2 * u);
const smooth01 = (x: number): number => smooth(Math.min(Math.max(x, 0), 1));

interface Interval {
  frames: number;
  kind: 'walk' | 'turn' | 'wait';
  from: { x: number; z: number; yaw: number };
  to: { x: number; z: number; yaw: number };
}

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ARM_HANG_L = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -Math.PI / 2);
const ARM_HANG_R = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2);

const LEG_SWING = 0.55;
const KNEE_BEND = 1.0;
const ARM_SWING = 0.4;

interface FrameState {
  x: number;
  z: number;
  yaw: number;
  phase: number;
  amp: number;
}

/** 单帧姿态：步态振幅 amp ∈ [0,1]，0 为直立静止（停步/原地转向）。 */
function writeStageFrame(clip: Clip, skel: Skeleton, frame: number, st: FrameState): void {
  const phi = st.phase;
  const amp = st.amp;
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const rest = (bone: number) => new THREE.Vector3(...skel.bones[bone].restPos);

  setFramePos(clip, BONE.Root, frame, new THREE.Vector3(st.x, 0, st.z));
  setFrameQuat(clip, BONE.Root, frame, q.setFromAxisAngle(UP, st.yaw));

  const bob = 0.04 * (0.5 - 0.5 * Math.cos(2 * phi)) * amp;
  setFramePos(
    clip,
    BONE.Hips,
    frame,
    rest(BONE.Hips).add(new THREE.Vector3(0.02 * Math.sin(phi) * amp, -bob, 0)),
  );
  setFrameQuat(clip, BONE.Hips, frame, q.setFromAxisAngle(UP, 0.08 * Math.sin(phi) * amp));

  setFramePos(clip, BONE.Spine, frame, rest(BONE.Spine));
  setFrameQuat(clip, BONE.Spine, frame, q.setFromAxisAngle(UP, -0.06 * Math.sin(phi) * amp));

  setFramePos(clip, BONE.Head, frame, rest(BONE.Head));
  setFrameQuat(clip, BONE.Head, frame, q.identity());

  const swingL = -LEG_SWING * Math.sin(phi) * amp;
  const swingR = LEG_SWING * Math.sin(phi) * amp;
  const kneeL = KNEE_BEND * Math.max(0, Math.cos(phi)) * amp;
  const kneeR = KNEE_BEND * Math.max(0, -Math.cos(phi)) * amp;

  setFramePos(clip, BONE.UpperLegL, frame, rest(BONE.UpperLegL));
  setFrameQuat(clip, BONE.UpperLegL, frame, q.setFromAxisAngle(X_AXIS, swingL));
  setFramePos(clip, BONE.LowerLegL, frame, rest(BONE.LowerLegL));
  setFrameQuat(clip, BONE.LowerLegL, frame, q.setFromAxisAngle(X_AXIS, kneeL));
  setFramePos(clip, BONE.FootL, frame, rest(BONE.FootL));
  setFrameQuat(clip, BONE.FootL, frame, q.identity());

  setFramePos(clip, BONE.UpperLegR, frame, rest(BONE.UpperLegR));
  setFrameQuat(clip, BONE.UpperLegR, frame, q.setFromAxisAngle(X_AXIS, swingR));
  setFramePos(clip, BONE.LowerLegR, frame, rest(BONE.LowerLegR));
  setFrameQuat(clip, BONE.LowerLegR, frame, q.setFromAxisAngle(X_AXIS, kneeR));
  setFramePos(clip, BONE.FootR, frame, rest(BONE.FootR));
  setFrameQuat(clip, BONE.FootR, frame, q.identity());

  setFramePos(clip, BONE.ArmL, frame, rest(BONE.ArmL));
  q.setFromAxisAngle(X_AXIS, ARM_SWING * Math.sin(phi) * amp).multiply(ARM_HANG_L);
  setFrameQuat(clip, BONE.ArmL, frame, q);
  setFramePos(clip, BONE.ForearmL, frame, rest(BONE.ForearmL));
  setFrameQuat(clip, BONE.ForearmL, frame, q2.identity());

  setFramePos(clip, BONE.ArmR, frame, rest(BONE.ArmR));
  q.setFromAxisAngle(X_AXIS, -ARM_SWING * Math.sin(phi) * amp).multiply(ARM_HANG_R);
  setFrameQuat(clip, BONE.ArmR, frame, q);
  setFramePos(clip, BONE.ForearmR, frame, rest(BONE.ForearmR));
  setFrameQuat(clip, BONE.ForearmR, frame, q2.identity());
}

/**
 * 编译走位编排为动画片段（米制场景单位）。
 * 单位换算（如 cm 工程）由素材烘焙层负责，此处输出恒为米。
 */
export function compileSegmentClip(
  spec: SegmentChoreography,
  skel: Skeleton,
  fps: number,
  name: string,
): Clip {
  if (!Number.isFinite(spec.rootScale) || spec.rootScale <= 0) {
    throw new Error(`rootScale 必须为正数，收到 ${String(spec.rootScale)}`);
  }

  // 第一遍：动作序列 → 关键帧区间（时长量化到整帧，端点精确）
  const intervals: Interval[] = [];
  let x = spec.start.pos[0];
  let z = spec.start.pos[2];
  let yaw = spec.start.yawDeg * DEG;
  for (const move of spec.moves) {
    if (move.type === 'walkTo') {
      const dx = move.to[0] - x;
      const dz = move.to[1] - z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-9) throw new Error('walkTo 目标与当前位置重合');
      if (!Number.isFinite(move.speed) || move.speed <= 0) {
        throw new Error(`walkTo 速度必须为正数，收到 ${String(move.speed)}`);
      }
      const heading = Math.atan2(dx, dz);
      const headingErr = Math.abs(wrapPi(heading - yaw));
      if (headingErr > 1e-6) {
        throw new Error(
          `walkTo 前未对准方向：当前朝向 ${(yaw / DEG).toFixed(3)}°，路径方向 ${(heading / DEG).toFixed(3)}°（需先 turnTo）`,
        );
      }
      const frames = Math.max(1, Math.round((dist / move.speed) * fps));
      intervals.push({ frames, kind: 'walk', from: { x, z, yaw }, to: { x: move.to[0], z: move.to[1], yaw } });
      x = move.to[0];
      z = move.to[1];
    } else if (move.type === 'turnTo') {
      const hasYaw = move.yawDeg !== undefined;
      const hasHeading = move.headingTo !== undefined;
      if (hasYaw === hasHeading) {
        throw new Error('turnTo 必须且只能提供 yawDeg 或 headingTo 之一');
      }
      if (!Number.isFinite(move.yawRateDeg) || move.yawRateDeg <= 0) {
        throw new Error(`turnTo 转向速率必须为正数，收到 ${String(move.yawRateDeg)}`);
      }
      const target = hasYaw
        ? (move.yawDeg as number) * DEG
        : Math.atan2((move.headingTo as [number, number])[0] - x, (move.headingTo as [number, number])[1] - z);
      const delta =
        move.direction === 'ccw' ? mod2pi(target - yaw) : -mod2pi(yaw - target);
      if (Math.abs(delta) < 1e-9) throw new Error('turnTo 无实际转角');
      const frames = Math.max(1, Math.round((Math.abs(delta) / (move.yawRateDeg * DEG)) * fps));
      intervals.push({ frames, kind: 'turn', from: { x, z, yaw }, to: { x, z, yaw: yaw + delta } });
      yaw += delta;
    } else if (move.type === 'wait') {
      if (!Number.isFinite(move.duration) || move.duration <= 0) {
        throw new Error(`wait 时长必须为正数，收到 ${String(move.duration)}`);
      }
      const frames = Math.max(1, Math.round(move.duration * fps));
      intervals.push({ frames, kind: 'wait', from: { x, z, yaw }, to: { x, z, yaw } });
    } else {
      throw new Error(`未知动作类型: ${String((move as Move).type)}`);
    }
  }
  if (intervals.length === 0) throw new Error('片段至少需要一个动作');

  const totalFrames = intervals.reduce((s, iv) => s + iv.frames, 0);
  const duration = totalFrames / fps;
  const clip = createClip(name, duration, fps, skel.bones.length);

  // 第二遍：逐帧写姿态。根位移缩放绕片段起点施加；步态相位按未缩放弧长累计，
  // 因此 rootScale ≠ 1 时脚步相对地面打滑 —— 这正是根位移设置差异的可视特征。
  const startX = spec.start.pos[0];
  const startZ = spec.start.pos[2];
  let frame = 0;
  let phase = 0;
  let prevX = startX;
  let prevZ = startZ;

  const emit = (px: number, pz: number, pyaw: number, speed: number): void => {
    phase += (2 * Math.PI * Math.hypot(px - prevX, pz - prevZ)) / STRIDE_M;
    prevX = px;
    prevZ = pz;
    const sx = startX + (px - startX) * spec.rootScale;
    const sz = startZ + (pz - startZ) * spec.rootScale;
    writeStageFrame(clip, skel, frame, {
      x: sx,
      z: sz,
      yaw: pyaw,
      phase,
      amp: smooth01(speed / 0.45),
    });
    frame++;
  };

  for (const iv of intervals) {
    const dist = Math.hypot(iv.to.x - iv.from.x, iv.to.z - iv.from.z);
    const durSec = iv.frames / fps;
    for (let k = 0; k < iv.frames; k++) {
      const u = k / iv.frames;
      const e = smooth(u);
      const px = iv.from.x + (iv.to.x - iv.from.x) * e;
      const pz = iv.from.z + (iv.to.z - iv.from.z) * e;
      const pyaw = iv.from.yaw + (iv.to.yaw - iv.from.yaw) * e;
      // smoothstep 瞬时速度：dist * 6u(1-u) / durSec（walk 之外为 0）
      const speed = iv.kind === 'walk' ? (dist * 6 * u * (1 - u)) / durSec : 0;
      emit(px, pz, pyaw, speed);
    }
  }
  // 尾帧：最后区间的终点（落点精确）
  const last = intervals[intervals.length - 1];
  emit(last.to.x, last.to.z, last.to.yaw, 0);

  if (frame !== clip.frameCount) {
    throw new Error(`内部错误：写出帧数 ${frame} 与片段帧数 ${clip.frameCount} 不符`);
  }
  return clip;
}
