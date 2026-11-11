import { describe, expect, it } from 'vitest';
import { extractRootMotion } from '../src/core/extract';
import { Player } from '../src/core/player';
import { exportScene, importScene } from '../src/core/serialize';
import { buildSkeleton, makeTurnClip } from '../src/core/testClips';

describe('导出/载入还原', () => {
  it('导出的分离动画与轨迹重新载入后求值一致', () => {
    const skel = buildSkeleton();
    const { trajectory, inPlace } = extractRootMotion(skel, makeTurnClip(skel));
    const player = new Player(skel, inPlace, trajectory);
    player.setTime(2.34);
    player.speed = -1.25;
    player.loop = true;

    const json = exportScene(player, '转弯');
    const restored = importScene(json);

    expect(restored.clipName).toBe('转弯');
    expect(restored.player.time).toBeCloseTo(2.34, 12);
    expect(restored.player.speed).toBeCloseTo(-1.25, 12);
    expect(restored.player.loop).toBe(true);

    // 轨迹逐点一致（含跨循环时刻）
    for (const t of [0, 0.5, 1.3, 4.4, 5.0, 9.7, -2.2]) {
      const a = player.rootFrameAt(t);
      const b = restored.player.rootFrameAt(t);
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
      expect(Math.abs(a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-6);
    }

    // 重组世界姿态一致
    const wa = player.worldPoseAt(3.21).pos;
    const wb = restored.player.worldPoseAt(3.21).pos;
    for (let i = 0; i < wa.length; i++) {
      expect(wb[i].distanceTo(wa[i])).toBeLessThan(1e-6);
    }
  });

  it('格式不符时拒绝载入', () => {
    expect(() => importScene('{"format":"other/9"}')).toThrow();
    expect(() => importScene('not json')).toThrow();
  });
});
