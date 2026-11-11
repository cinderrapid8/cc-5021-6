import { describe, expect, it } from 'vitest';
import { extractRootMotion } from '../src/core/extract';
import { trajCompose, trajIdentity, trajInverse, trajPow } from '../src/core/math';
import { buildSkeleton, makeStraightClip, makeTurnClip } from '../src/core/testClips';

const closeFrame = (a: { x: number; y: number; z: number; yaw: number }, b: { x: number; y: number; z: number; yaw: number }, tol = 1e-6) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
  expect(Math.abs(a.z - b.z)).toBeLessThan(tol);
  expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(tol);
};

describe('轨迹帧代数', () => {
  it('复合与互逆：F ∘ F⁻¹ = 单位变换', () => {
    const f = { x: 1.2, y: 0.1, z: -0.7, yaw: 2.3 };
    closeFrame(trajCompose(f, trajInverse(f)), trajIdentity(), 1e-12);
    closeFrame(trajCompose(trajInverse(f), f), trajIdentity(), 1e-12);
  });

  it('整数次幂等价于反复复合，负幂等价于逆的幂', () => {
    const f = { x: 0.3, y: 0, z: 1.1, yaw: 0.7 };
    closeFrame(trajPow(f, 3), trajCompose(trajCompose(f, f), f), 1e-12);
    closeFrame(trajPow(f, -2), trajCompose(trajInverse(f), trajInverse(f)), 1e-12);
    closeFrame(trajCompose(trajPow(f, 5), trajPow(f, -5)), trajIdentity(), 1e-12);
  });
});

describe('循环播放的周期位移累计', () => {
  it('直行：每循环净前进 5.6 m，可任意循环次数直接求值', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeStraightClip(skel));
    const T = trajectory.duration;

    closeFrame(trajectory.evaluate(T, true), { x: 0, y: 0, z: 5.6, yaw: 0 }, 1e-5);
    closeFrame(trajectory.evaluate(2 * T + 1, true), { x: 0, y: 0, z: 11.2 + 1.4, yaw: 0 }, 1e-5);
    closeFrame(trajectory.evaluate(10 * T + 0.5, true), { x: 0, y: 0, z: 56 + 0.7, yaw: 0 }, 1e-4);

    // 循环边界连续：跨边界无跳变
    const eps = 1e-4;
    const before = trajectory.evaluate(T - eps, true);
    const after = trajectory.evaluate(T + eps, true);
    closeFrame(before, after, 1e-2);
  });

  it('转弯：循环累计旋转超过整圈仍连续', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeTurnClip(skel));
    const T = trajectory.duration;
    const totalYaw = (Math.PI / 2) * T;

    // 第二圈同一相位：偏航 = 第一圈偏航 + 整周期转角
    const a = trajectory.evaluate(1.0, true);
    const b = trajectory.evaluate(T + 1.0, true);
    expect(b.yaw - a.yaw).toBeCloseTo(totalYaw, 5);
    expect(b.yaw).toBeGreaterThan(2 * Math.PI);

    // 边界连续（位置与朝向）
    const eps = 1e-4;
    closeFrame(trajectory.evaluate(T - eps, true), trajectory.evaluate(T + eps, true), 1e-2);
    closeFrame(trajectory.evaluate(2 * T - eps, true), trajectory.evaluate(2 * T + eps, true), 1e-2);
  });

  it('倒放到 t<0：按逆周期延伸，过原点连续', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeStraightClip(skel));
    const eps = 1e-4;
    closeFrame(trajectory.evaluate(-eps, true), trajectory.evaluate(eps, true), 1e-2);
    // 倒退一个周期 = 后退 5.6 m
    closeFrame(trajectory.evaluate(-trajectory.duration, true), { x: 0, y: 0, z: -5.6, yaw: 0 }, 1e-5);
  });

  it('非循环模式夹在 [0, T]', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeStraightClip(skel));
    closeFrame(trajectory.evaluate(999, false), trajectory.evaluate(trajectory.duration, false));
    closeFrame(trajectory.evaluate(-3, false), trajectory.evaluate(0, false));
  });
});
