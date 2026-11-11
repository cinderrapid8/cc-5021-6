import * as THREE from 'three';
import { Clip, samplePose } from './clip';
import { TrajFrame, trajApplyToLocal } from './math';
import {
  Pose,
  Skeleton,
  WorldPose,
  forwardKinematics,
  makePose,
  makeWorldPose,
} from './skeleton';
import { Trajectory } from './trajectory';

/**
 * 重组播放器：原地动画 + 轨迹在可调速度下合成世界姿态。
 * 状态完全由 time 决定（纯函数求值），暂停/倒放/跳转都只是改写 time，
 * 不依赖从头播放累积，因此可复算、无积分漂移。
 */
export class Player {
  time = 0;
  speed = 1; // 可为负：倒放
  playing = false;
  loop = true;

  private pose: Pose;
  private world: WorldPose;

  constructor(
    public readonly skel: Skeleton,
    public readonly inPlace: Clip,
    public readonly trajectory: Trajectory,
  ) {
    this.pose = makePose(skel);
    this.world = makeWorldPose(skel);
  }

  get duration(): number {
    return this.inPlace.duration;
  }

  setTime(t: number): void {
    this.time = t;
  }

  advance(dt: number): void {
    if (this.playing) this.time += dt * this.speed;
  }

  /** 动画局部时间：循环时取模到 [0, T)，否则夹到 [0, T]。 */
  localTime(t: number): number {
    const T = this.inPlace.duration;
    if (!this.loop) return Math.min(Math.max(t, 0), T);
    const tau = t % T;
    return tau < 0 ? tau + T : tau;
  }

  rootFrameAt(t: number): TrajFrame {
    return this.trajectory.evaluate(t, this.loop);
  }

  /** 重组后的世界姿态：轨迹帧 ∘ 原地根骨，再对整副骨架做 FK。 */
  worldPoseAt(t: number): WorldPose {
    samplePose(this.inPlace, this.skel, this.localTime(t), this.pose);
    const frame = this.trajectory.evaluate(t, this.loop);
    const rootPos = new THREE.Vector3();
    const rootQuat = new THREE.Quaternion();
    trajApplyToLocal(
      frame,
      this.pose.pos[this.skel.rootIndex],
      this.pose.quat[this.skel.rootIndex],
      rootPos,
      rootQuat,
    );
    forwardKinematics(this.skel, this.pose, this.world, rootPos, rootQuat);
    return this.world;
  }

  /** 瞬时轨迹速度（m/s，speed=1 时）与偏航角速度（rad/s），中心差分。 */
  rootMotionRateAt(t: number): { speed: number; yawRate: number } {
    const e = Math.min(1e-3, this.inPlace.duration / 100);
    const a = this.trajectory.evaluate(t - e, this.loop);
    const b = this.trajectory.evaluate(t + e, this.loop);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    return {
      speed: Math.hypot(dx, dy, dz) / (2 * e),
      yawRate: (b.yaw - a.yaw) / (2 * e),
    };
  }
}
