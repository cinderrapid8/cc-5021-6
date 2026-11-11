import { describe, expect, it } from 'vitest';
import { extractRootMotion } from '../src/core/extract';
import { Player } from '../src/core/player';
import { buildSkeleton, makeAsymmetricClip, makeStraightClip } from '../src/core/testClips';

function makePlayer(loop = true) {
  const skel = buildSkeleton();
  const { trajectory, inPlace } = extractRootMotion(skel, makeStraightClip(skel));
  const player = new Player(skel, inPlace, trajectory);
  player.loop = loop;
  return player;
}

describe('可复算状态（暂停/倒放/跳转不依赖从头播放）', () => {
  it('同一时刻任意顺序求值结果一致', () => {
    const p = makePlayer();
    p.worldPoseAt(0);
    p.worldPoseAt(3.3);
    const a = p.worldPoseAt(1.234).pos.map((v) => v.clone());
    p.worldPoseAt(2.7);
    const b = p.worldPoseAt(1.234).pos;
    for (let i = 0; i < a.length; i++) {
      expect(b[i].distanceTo(a[i])).toBeLessThan(1e-12);
    }
  });

  it('暂停后跳转等价于直接求值；倒放经过的时间可正可负', () => {
    const p = makePlayer();
    p.playing = true;
    p.speed = 2;
    p.advance(0.5); // t = 1.0
    p.playing = false; // 暂停
    p.advance(10); // 暂停中不改变时间
    expect(p.time).toBeCloseTo(1.0, 12);

    p.setTime(5.5); // 跳转
    const direct = p.worldPoseAt(5.5).pos.map((v) => v.clone());
    const current = p.worldPoseAt(p.time).pos;
    for (let i = 0; i < direct.length; i++) {
      expect(current[i].distanceTo(direct[i])).toBeLessThan(1e-12);
    }

    p.speed = -1.5; // 倒放
    p.playing = true;
    p.advance(2); // t = 5.5 - 3 = 2.5
    expect(p.time).toBeCloseTo(2.5, 12);
    const at25 = p.worldPoseAt(2.5).pos;
    const now = p.worldPoseAt(p.time).pos;
    for (let i = 0; i < at25.length; i++) {
      expect(now[i].distanceTo(at25[i])).toBeLessThan(1e-12);
    }
  });

  it('循环与非循环的局部时间', () => {
    const p = makePlayer(true);
    const T = p.duration;
    expect(p.localTime(T + 0.25)).toBeCloseTo(0.25, 12);
    expect(p.localTime(-0.5)).toBeCloseTo(T - 0.5, 12);
    p.loop = false;
    expect(p.localTime(999)).toBeCloseTo(T, 12);
    expect(p.localTime(-1)).toBeCloseTo(0, 12);
  });
});

describe('前后不对称片段', () => {
  it('净位移与方向反转正确', () => {
    const skel = buildSkeleton();
    const { trajectory } = extractRootMotion(skel, makeAsymmetricClip(skel));
    expect(trajectory.evaluate(2, false).z).toBeCloseTo(3.6, 5);
    expect(trajectory.evaluate(3, false).z).toBeCloseTo(3.6, 5);
    expect(trajectory.evaluate(5, false).z).toBeCloseTo(2.8, 5);
    // 倒退段：位置随时间向回走
    expect(trajectory.evaluate(4, false).z).toBeLessThan(trajectory.evaluate(3, false).z);
    expect(trajectory.evaluate(5, false).z).toBeLessThan(trajectory.evaluate(4, false).z);
  });
});
