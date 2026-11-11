import * as THREE from 'three';
import { Clip, createClip, getFramePos, getFrameQuat, setFramePos, setFrameQuat } from './clip';
import { TrajFrame, trajRemoveFromWorld, yawDelta, yawOfQuaternion } from './math';
import { Skeleton } from './skeleton';
import { Trajectory } from './trajectory';

export interface ExtractedMotion {
  trajectory: Trajectory;
  /** 根骨水平移动与朝向已被移除的动画（根骨位置恒为原点，仅保留躯干/四肢动作与根的俯仰滚转） */
  inPlace: Clip;
}

/**
 * 从动画片段提取根运动：
 *  - 轨迹位置 = 根骨世界位置（逐帧采样）
 *  - 轨迹偏航 = 由四元数帧间增量连续累积的绕 Y 角（不用欧拉角差分，跨界不掉头）
 *  - 原地片段的根骨局部位姿 = 轨迹帧的逆 ∘ 根骨世界位姿（精确互补，可无损重组）
 */
export function extractRootMotion(skel: Skeleton, clip: Clip): ExtractedMotion {
  const root = skel.rootIndex;
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qPrev = new THREE.Quaternion();

  const samples: TrajFrame[] = new Array(clip.frameCount);
  const inPlace = createClip(`${clip.name} (in-place)`, clip.duration, clip.fps, clip.boneCount);

  const localP = new THREE.Vector3();
  const localQ = new THREE.Quaternion();

  let yaw = 0;
  for (let i = 0; i < clip.frameCount; i++) {
    // 根骨挂在场景根上，其局部位姿即世界位姿
    getFramePos(clip, root, i, p);
    getFrameQuat(clip, root, i, q);

    if (i === 0) {
      yaw = yawOfQuaternion(q);
    } else {
      yaw += yawDelta(qPrev, q);
    }
    qPrev.copy(q);

    const frame: TrajFrame = { x: p.x, y: p.y, z: p.z, yaw };
    samples[i] = frame;

    // 原地根骨 = 轨迹帧的逆 ∘ 世界位姿；其余骨骼原样拷贝
    trajRemoveFromWorld(frame, p, q, localP, localQ);
    setFramePos(inPlace, root, i, localP);
    setFrameQuat(inPlace, root, i, localQ);
    for (let b = 0; b < clip.boneCount; b++) {
      if (b === root) continue;
      getFramePos(clip, b, i, localP);
      getFrameQuat(clip, b, i, localQ);
      setFramePos(inPlace, b, i, localP);
      setFrameQuat(inPlace, b, i, localQ);
    }
  }

  return { trajectory: Trajectory.fromSamples(samples, clip.duration, clip.fps), inPlace };
}
