import * as THREE from 'three';
import { Pose, Skeleton } from './skeleton';

/**
 * 均匀采样动画片段：所有骨骼在每一帧都有局部位置与局部旋转样本。
 * 帧 i 对应时间 i / fps，共 frameCount = duration * fps + 1 帧（含首尾）。
 */
export interface Clip {
  name: string;
  duration: number;
  fps: number;
  frameCount: number;
  boneCount: number;
  /** 布局：bone * frameCount * 3 + frame * 3 + comp */
  pos: Float32Array;
  /** 布局：bone * frameCount * 4 + frame * 4 + comp */
  quat: Float32Array;
}

export function createClip(name: string, duration: number, fps: number, boneCount: number): Clip {
  const frameCount = Math.round(duration * fps) + 1;
  return {
    name,
    duration,
    fps,
    frameCount,
    boneCount,
    pos: new Float32Array(boneCount * frameCount * 3),
    quat: new Float32Array(boneCount * frameCount * 4),
  };
}

export function setFramePos(clip: Clip, bone: number, frame: number, p: THREE.Vector3): void {
  const o = (bone * clip.frameCount + frame) * 3;
  clip.pos[o] = p.x;
  clip.pos[o + 1] = p.y;
  clip.pos[o + 2] = p.z;
}

export function setFrameQuat(clip: Clip, bone: number, frame: number, q: THREE.Quaternion): void {
  const o = (bone * clip.frameCount + frame) * 4;
  clip.quat[o] = q.x;
  clip.quat[o + 1] = q.y;
  clip.quat[o + 2] = q.z;
  clip.quat[o + 3] = q.w;
}

export function getFramePos(clip: Clip, bone: number, frame: number, out: THREE.Vector3): void {
  const o = (bone * clip.frameCount + frame) * 3;
  out.set(clip.pos[o], clip.pos[o + 1], clip.pos[o + 2]);
}

export function getFrameQuat(clip: Clip, bone: number, frame: number, out: THREE.Quaternion): void {
  const o = (bone * clip.frameCount + frame) * 4;
  out.set(clip.quat[o], clip.quat[o + 1], clip.quat[o + 2], clip.quat[o + 3]);
}

/**
 * 在 t ∈ [0, duration] 上采样局部姿态（线性插值 + 归一化四元数球面近似）。
 * t 会被夹到合法范围；跨循环边界的回绕由调用方负责（见 Player.localTime）。
 */
export function samplePose(clip: Clip, skel: Skeleton, t: number, out: Pose): void {
  const tt = Math.min(Math.max(t, 0), clip.duration);
  const s = tt * clip.fps;
  const i = Math.min(Math.floor(s), clip.frameCount - 2);
  const f = Math.min(Math.max(s - i, 0), 1);
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  for (let b = 0; b < clip.boneCount; b++) {
    getFramePos(clip, b, i, pa);
    getFramePos(clip, b, i + 1, pb);
    out.pos[b].lerpVectors(pa, pb, f);
    getFrameQuat(clip, b, i, qa);
    getFrameQuat(clip, b, i + 1, qb);
    out.quat[b].copy(qa).slerp(qb, f).normalize();
  }
}
