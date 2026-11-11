import * as THREE from 'three';
import { Clip, getFramePos, getFrameQuat, samplePose } from './clip';
import { TrajFrame, trajApplyToLocal, trajCompose, trajInverse, trajPow, yawOfQuaternion } from './math';
import { Player } from './player';
import { Skeleton, WorldPose, forwardKinematics, makePose, makeWorldPose } from './skeleton';

/**
 * 由原片段根骨关键帧直接算出的整周期位移增量（独立于提取出的轨迹，
 * 用作对照基准）。偏航取首末帧朝向的绝对值之差（模 2π 等价即可，
 * 旋转合成不受绕圈数影响）。
 */
const cycleCache = new WeakMap<Clip, TrajFrame>();

function clipRootFrame(clip: Clip, root: number, frame: number): TrajFrame {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  getFramePos(clip, root, frame, p);
  getFrameQuat(clip, root, frame, q);
  return { x: p.x, y: p.y, z: p.z, yaw: yawOfQuaternion(q) };
}

export function clipCycleDelta(skel: Skeleton, clip: Clip): TrajFrame {
  let cycle = cycleCache.get(clip);
  if (!cycle) {
    const first = clipRootFrame(clip, skel.rootIndex, 0);
    const last = clipRootFrame(clip, skel.rootIndex, clip.frameCount - 1);
    cycle = trajCompose(last, trajInverse(first));
    cycleCache.set(clip, cycle);
  }
  return cycle;
}

/**
 * 原动画在全局时刻 t 的世界姿态（对照基准）。
 * 循环时根骨按原片段自身的周期增量累计（cycle^n ∘ 根骨(τ)），
 * 与重组播放器走同一套循环语义，但数据来源完全独立。
 */
export function originalWorldPoseAt(
  skel: Skeleton,
  clip: Clip,
  t: number,
  loop: boolean,
): WorldPose {
  const T = clip.duration;
  const n = loop ? Math.floor(t / T) : 0;
  let tau = loop ? t - n * T : Math.min(Math.max(t, 0), T);
  tau = Math.min(Math.max(tau, 0), T);

  const pose = makePose(skel);
  const world = makeWorldPose(skel);
  samplePose(clip, skel, tau, pose);

  const root = skel.rootIndex;
  const placement = trajPow(clipCycleDelta(skel, clip), n);
  const rootPos = new THREE.Vector3();
  const rootQuat = new THREE.Quaternion();
  trajApplyToLocal(placement, pose.pos[root], pose.quat[root], rootPos, rootQuat);
  forwardKinematics(skel, pose, world, rootPos, rootQuat);
  return world;
}

/** 两副世界姿态的逐骨骼最大位置误差（米）。 */
export function maxBonePosError(a: WorldPose, b: WorldPose): number {
  let max = 0;
  for (let i = 0; i < a.pos.length; i++) {
    max = Math.max(max, a.pos[i].distanceTo(b.pos[i]));
  }
  return max;
}

/** 重组结果与原动画在 t 时刻的逐骨骼最大位置误差。 */
export function recombineErrorAt(
  skel: Skeleton,
  original: Clip,
  player: Player,
  t: number,
): number {
  const recombined = player.worldPoseAt(t);
  const reference = originalWorldPoseAt(skel, original, t, player.loop);
  return maxBonePosError(recombined, reference);
}
