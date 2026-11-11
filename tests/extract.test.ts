import { describe, expect, it } from 'vitest';
import { recombineErrorAt } from '../src/core/compare';
import { extractRootMotion } from '../src/core/extract';
import { yawOfQuaternion } from '../src/core/math';
import { Player } from '../src/core/player';
import { getFrameQuat } from '../src/core/clip';
import * as THREE from 'three';
import {
  buildSkeleton,
  makeAsymmetricClip,
  makeStraightClip,
  makeTurnClip,
} from '../src/core/testClips';

const TURN_TOTAL_YAW = (Math.PI / 2) * 4.5; // 405°

describe('根运动提取', () => {
  it('转弯片段的偏航角连续累积，跨越 ±π 不掉头、不取模', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeTurnClip(skel));

    const yaws = trajectory.samples.map((s) => s.yaw);
    // 单调递增（持续同向转弯）
    for (let i = 1; i < yaws.length; i++) {
      expect(yaws[i]).toBeGreaterThan(yaws[i - 1]);
      // 帧间增量小：没有跨界跳变
      expect(yaws[i] - yaws[i - 1]).toBeLessThan(0.2);
    }
    // 累计 405°，必须超过 2π（未被包络到 [-π, π]）
    const last = yaws[yaws.length - 1];
    expect(last).toBeGreaterThan(2 * Math.PI);
    expect(last).toBeCloseTo(TURN_TOTAL_YAW, 3);
  });

  it('原地片段的根骨不携带净位移与净转向', () => {
    const skel = buildSkeleton();
    const { inPlace } = extractRootMotion(skel, makeTurnClip(skel));
    const q = new THREE.Quaternion();
    for (let i = 0; i < inPlace.frameCount; i++) {
      // 根骨位置恒为原点（轨迹拿走了全部平移）
      const o = (skel.rootIndex * inPlace.frameCount + i) * 3;
      expect(Math.abs(inPlace.pos[o])).toBeLessThan(1e-5);
      expect(Math.abs(inPlace.pos[o + 2])).toBeLessThan(1e-5);
      // 根骨朝向恒接近零（轨迹拿走了全部偏航）
      getFrameQuat(inPlace, skel.rootIndex, i, q);
      expect(Math.abs(yawOfQuaternion(q))).toBeLessThan(1e-3);
    }
  });

  it.each([
    ['直行', makeStraightClip],
    ['转弯', makeTurnClip],
    ['前后不对称', makeAsymmetricClip],
  ])('重组与原动画一致：%s（骨骼位置与整体路径）', (_name, makeClip) => {
    const skel = buildSkeleton();
    const clip = makeClip(skel);
    const { trajectory, inPlace } = extractRootMotion(skel, clip);
    const player = new Player(skel, inPlace, trajectory);
    player.loop = false;

    // 整帧时刻：应几乎精确
    for (let i = 0; i < clip.frameCount; i += 7) {
      const t = i / clip.fps;
      expect(recombineErrorAt(skel, clip, player, t)).toBeLessThan(1e-4);
    }
    // 半帧时刻：插值路径也应吻合
    for (let i = 0; i < clip.frameCount - 1; i += 11) {
      const t = (i + 0.5) / clip.fps;
      expect(recombineErrorAt(skel, clip, player, t)).toBeLessThan(1e-3);
    }

    // 循环模式：跨周期（含倒放到 t<0）仍与独立累计的原动画一致
    player.loop = true;
    const T = clip.duration;
    for (const t of [T + 0.77, 2 * T + 1.23, 3 * T - 0.11, -0.5, -T - 1.4]) {
      expect(recombineErrorAt(skel, clip, player, t)).toBeLessThan(1e-3);
    }
  });

  it('提取的连续偏航与原片段根骨四元数逐帧一致（模 2π）', () => {
    const skel = buildSkeleton();
    const clip = makeTurnClip(skel);
    const { trajectory } = extractRootMotion(skel, clip);
    const q = new THREE.Quaternion();
    for (let i = 0; i < clip.frameCount; i += 5) {
      getFrameQuat(clip, skel.rootIndex, i, q);
      const wrapped = yawOfQuaternion(q); // 独立基准：atan2 绝对朝向
      const continuous = trajectory.samples[i].yaw;
      // 两者之差必须是整圈数，且连续值不被包络
      const turns = (continuous - wrapped) / (2 * Math.PI);
      expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-4);
    }
  });
});
