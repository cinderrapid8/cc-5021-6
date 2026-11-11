import * as THREE from 'three';

export interface BoneDef {
  name: string;
  parent: number; // -1 表示场景根
  restPos: [number, number, number];
}

export interface Skeleton {
  bones: BoneDef[];
  rootIndex: number;
}

/** 一帧局部姿态：每根骨骼的局部位置与局部旋转。 */
export interface Pose {
  pos: THREE.Vector3[];
  quat: THREE.Quaternion[];
}

export function makePose(skel: Skeleton): Pose {
  return {
    pos: skel.bones.map(() => new THREE.Vector3()),
    quat: skel.bones.map(() => new THREE.Quaternion()),
  };
}

export interface WorldPose {
  pos: THREE.Vector3[];
  quat: THREE.Quaternion[];
}

export function makeWorldPose(skel: Skeleton): WorldPose {
  return {
    pos: skel.bones.map(() => new THREE.Vector3()),
    quat: skel.bones.map(() => new THREE.Quaternion()),
  };
}

/**
 * 前向运动学。rootWorldPos/rootWorldQuat 给出根骨（rootIndex）在世界中的放置；
 * 缺省时根骨局部姿态即世界姿态（骨架直接挂在场景原点）。
 */
export function forwardKinematics(
  skel: Skeleton,
  pose: Pose,
  out: WorldPose,
  rootWorldPos?: THREE.Vector3,
  rootWorldQuat?: THREE.Quaternion,
): void {
  for (let i = 0; i < skel.bones.length; i++) {
    const bone = skel.bones[i];
    if (bone.parent < 0) {
      if (i === skel.rootIndex && rootWorldPos && rootWorldQuat) {
        out.pos[i].copy(rootWorldPos);
        out.quat[i].copy(rootWorldQuat);
      } else {
        out.pos[i].copy(pose.pos[i]);
        out.quat[i].copy(pose.quat[i]);
      }
    } else {
      out.pos[i]
        .copy(pose.pos[i])
        .applyQuaternion(out.quat[bone.parent])
        .add(out.pos[bone.parent]);
      out.quat[i].copy(out.quat[bone.parent]).multiply(pose.quat[i]);
    }
  }
}
