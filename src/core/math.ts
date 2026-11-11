import * as THREE from 'three';

export const UP = new THREE.Vector3(0, 1, 0);
export const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * 轨迹帧：场景中的根节点放置（位置 + 绕 Y 的连续偏航角）。
 * yaw 不做取模，可任意正负累积，保证旋转连续。
 */
export interface TrajFrame {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const trajIdentity = (): TrajFrame => ({ x: 0, y: 0, z: 0, yaw: 0 });

/** 变换复合：先应用 b，再应用 a（等价于矩阵 M_a * M_b）。 */
export function trajCompose(a: TrajFrame, b: TrajFrame): TrajFrame {
  const c = Math.cos(a.yaw);
  const s = Math.sin(a.yaw);
  return {
    x: a.x + c * b.x + s * b.z,
    y: a.y + b.y,
    z: a.z - s * b.x + c * b.z,
    yaw: a.yaw + b.yaw,
  };
}

export function trajInverse(f: TrajFrame): TrajFrame {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return {
    x: -(c * f.x - s * f.z),
    y: -f.y,
    z: -(s * f.x + c * f.z),
    yaw: -f.yaw,
  };
}

/** 整数次幂：循环 n 次的累计位移/转角。支持负 n（反向）。 */
export function trajPow(f: TrajFrame, n: number): TrajFrame {
  if (n === 0) return trajIdentity();
  if (n < 0) return trajPow(trajInverse(f), -n);
  let acc = trajIdentity();
  for (let i = 0; i < n; i++) acc = trajCompose(acc, f);
  return acc;
}

export function trajLerp(a: TrajFrame, b: TrajFrame, t: number): TrajFrame {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    // yaw 样本本身已连续（提取时做了展开），直接线性插值即可
    yaw: a.yaw + (b.yaw - a.yaw) * t,
  };
}

export function quatFromYaw(yaw: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(UP, yaw);
}

/** 角色朝向角：把四元数作用后的前向向量投影到 XZ 平面求 atan2。仅用于取绝对初值，不做帧间差分。 */
export function yawOfQuaternion(q: THREE.Quaternion): number {
  const f = FORWARD.clone().applyQuaternion(q);
  return Math.atan2(f.x, f.z);
}

/**
 * 相邻两帧朝向的连续增量（绕 Y 轴，弧度）。
 * 用四元数 swing-twist 分解取最短路径，不做欧拉角相减，
 * 因此跨越 ±π 边界时不会突然掉头。
 */
export function yawDelta(qPrev: THREE.Quaternion, qNext: THREE.Quaternion): number {
  const dq = qNext.clone().multiply(qPrev.clone().invert());
  if (dq.w < 0) {
    dq.set(-dq.x, -dq.y, -dq.z, -dq.w); // 同一旋转的另一半球，取最短路径
  }
  const len = Math.hypot(dq.y, dq.w);
  if (len < 1e-12) return 0;
  const ty = dq.y / len;
  const tw = dq.w / len;
  return 2 * Math.atan2(ty, tw);
}

/** 把局部根节点位姿放入轨迹帧，得到场景中的根节点位姿。 */
export function trajApplyToLocal(
  frame: TrajFrame,
  localPos: THREE.Vector3,
  localQuat: THREE.Quaternion,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
): void {
  const c = Math.cos(frame.yaw);
  const s = Math.sin(frame.yaw);
  outPos.set(
    frame.x + c * localPos.x + s * localPos.z,
    frame.y + localPos.y,
    frame.z - s * localPos.x + c * localPos.z,
  );
  outQuat.copy(quatFromYaw(frame.yaw)).multiply(localQuat);
}

/** 逆运算：已知场景中根节点位姿与轨迹帧，求局部（原地）根节点位姿。 */
export function trajRemoveFromWorld(
  frame: TrajFrame,
  worldPos: THREE.Vector3,
  worldQuat: THREE.Quaternion,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
): void {
  const dx = worldPos.x - frame.x;
  const dy = worldPos.y - frame.y;
  const dz = worldPos.z - frame.z;
  const c = Math.cos(-frame.yaw);
  const s = Math.sin(-frame.yaw);
  outPos.set(c * dx + s * dz, dy, -s * dx + c * dz);
  outQuat.copy(quatFromYaw(-frame.yaw)).multiply(worldQuat);
}
