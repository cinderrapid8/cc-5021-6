import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recombineErrorAt } from '../src/core/compare';
import { extractRootMotion } from '../src/core/extract';
import { Player } from '../src/core/player';
import { exportScene, importScene } from '../src/core/serialize';
import { CLIP_BUILDERS, buildSkeleton } from '../src/core/testClips';
import { compileSegmentClip } from '../src/blocking/choreography';
import {
  ClipAssetJson,
  clipFromAsset,
  parseCameras,
  parseClipAsset,
  parseProject,
  segmentSourceParams,
  stableStringify,
} from '../src/blocking/project';
import { verifySegment } from '../src/blocking/verify';

const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'stage-blocking');
const OUT_DIR = path.join(DEMO_DIR, 'out');

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

function loadDemo() {
  const spec = parseProject(readJson(path.join(DEMO_DIR, 'project.json')));
  const skel = buildSkeleton();
  const shots = parseCameras(readJson(path.join(DEMO_DIR, spec.camerasAsset)), new Set(spec.segments.map((s) => s.id)));
  const segments = spec.segments.map((seg) => {
    const asset = parseClipAsset(readJson(path.join(DEMO_DIR, seg.clipAsset)), skel) as ClipAssetJson;
    const loaded = clipFromAsset(asset, skel);
    const regenerated = compileSegmentClip(seg, skel, spec.fps, seg.id);
    const mark = spec.stage.marks.find((m) => m.id === seg.expect.markId)!;
    return { seg, asset, loaded, regenerated, mark };
  });
  return { spec, skel, shots, segments };
}

describe('走位演示工程：清单与素材严格加载', () => {
  it('工程清单、镜头标记、片段素材均可加载，镜头覆盖每个片段', () => {
    const { spec, shots, segments } = loadDemo();
    expect(spec.segments).toHaveLength(5);
    expect(segments.map((s) => s.seg.id)).toEqual([
      'enter-walk-stop',
      'turn-to-window',
      'cross-to-door',
      'enter-walk-stop-cm',
      'turn-to-window-halfroot',
    ]);
    expect(shots).toHaveLength(5);
    for (const seg of spec.segments) {
      expect(shots.some((s) => s.segmentId === seg.id)).toBe(true);
    }
  });

  it('缺单位、未知格式、未知字段一律拒绝（不以默认值遮错）', () => {
    const base = readJson(path.join(DEMO_DIR, 'project.json')) as Record<string, unknown>;
    expect(() => parseProject({ ...base, format: 'other/9' })).toThrow(/format/);

    const segs = base.segments as Record<string, unknown>[];
    const noUnits = { ...segs[0] };
    delete noUnits.units;
    expect(() => parseProject({ ...base, segments: [noUnits, ...segs.slice(1)] })).toThrow(/units|单位/);

    const badUnits = { ...segs[0], units: 'inch' };
    expect(() => parseProject({ ...base, segments: [badUnits, ...segs.slice(1)] })).toThrow(/单位/);

    const extraField = { ...segs[0], comment: 'oops' };
    expect(() => parseProject({ ...base, segments: [extraField, ...segs.slice(1)] })).toThrow(/未识别字段/);

    const noExpect = { ...segs[0] };
    delete noExpect.expect;
    expect(() => parseProject({ ...base, segments: [noExpect, ...segs.slice(1)] })).toThrow(/expect/);

    const { skel } = loadDemo();
    const asset = readJson(path.join(DEMO_DIR, 'assets/clips/enter-walk-stop.json')) as Record<string, unknown>;
    const assetNoUnits = { ...asset };
    delete assetNoUnits.units;
    expect(() => parseClipAsset(assetNoUnits, skel)).toThrow(/units|单位/);
    expect(() => parseClipAsset({ ...asset, format: 'clip/0' }, skel)).toThrow(/format/);
    expect(() => parseClipAsset({ ...asset, pos: [1, 2, 3] }, skel)).toThrow(/pos/);
  });
});

describe('走位演示工程：可重建与根运动约定', () => {
  it('片段素材可按清单参数重建（重编译结果与素材一致），来源参数记录一致', () => {
    const { spec, segments } = loadDemo();
    for (const { seg, asset, loaded, regenerated } of segments) {
      let maxDiff = 0;
      for (let i = 0; i < loaded.pos.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(loaded.pos[i] - regenerated.pos[i]));
      }
      for (let i = 0; i < loaded.quat.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(loaded.quat[i] - regenerated.quat[i]));
      }
      expect(maxDiff).toBeLessThanOrEqual(spec.tolerances.reloadDiff);
      expect(stableStringify(asset.source.params)).toBe(stableStringify(segmentSourceParams(seg, spec.fps)));
    }
  });

  it('逐片段核验通过：落点、落点朝向、根位移、净转角、单位倍率、标记偏差', () => {
    const { spec, skel, segments } = loadDemo();
    for (const { seg, asset, loaded, regenerated, mark } of segments) {
      const { checks } = verifySegment({
        seg,
        fps: spec.fps,
        tolerances: spec.tolerances,
        skel,
        mark,
        asset,
        regenerated,
        loaded,
      });
      const failed = checks.filter((c) => !c.pass);
      expect(failed, `${seg.id}: ${failed.map((c) => c.check).join(',')}`).toHaveLength(0);
    }
  });

  it('重组结果符合根运动约定：各片段重组误差 < 1mm', () => {
    const { skel, segments } = loadDemo();
    for (const { loaded } of segments) {
      const { trajectory, inPlace } = extractRootMotion(skel, loaded);
      const player = new Player(skel, inPlace, trajectory);
      player.loop = false;
      for (let i = 0; i < loaded.frameCount; i += 9) {
        expect(recombineErrorAt(skel, loaded, player, i / loaded.fps)).toBeLessThan(1e-3);
      }
    }
  });
});

describe('对照片段：场景单位与根位移差异可辨认', () => {
  it('cm 工程：原始素材坐标为米制的 100 倍，归一化后轨迹与米制片段一致', () => {
    const { segments } = loadDemo();
    const meter = segments.find((s) => s.seg.id === 'enter-walk-stop')!;
    const cm = segments.find((s) => s.seg.id === 'enter-walk-stop-cm')!;
    expect(cm.seg.units).toBe('cm');

    const maxRaw = (asset: ClipAssetJson): number => {
      let max = 0;
      for (let f = 0; f < asset.frameCount; f++) {
        max = Math.max(max, Math.hypot(asset.pos[f * 3], asset.pos[f * 3 + 2]));
      }
      return max;
    };
    expect(maxRaw(cm.asset)).toBeGreaterThan(200); // 厘米读数（约 280）
    expect(maxRaw(meter.asset)).toBeLessThan(5); // 米制读数（约 2.8）
    expect(maxRaw(cm.asset) / maxRaw(meter.asset)).toBeCloseTo(100, 3);

    const skel = buildSkeleton();
    const trajM = extractRootMotion(skel, meter.loaded).trajectory;
    const trajC = extractRootMotion(skel, cm.loaded).trajectory;
    for (const t of [0, 0.5, 1.2, 2.0, 3.0, trajM.duration]) {
      const a = trajM.evaluate(t, false);
      const b = trajC.evaluate(t, false);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-4);
      expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-4);
    }
  });

  it('根位移×0.5 工程：落点停在半程，与舞台标记的偏差恰为声明的 1.5 m', () => {
    const { spec, skel, segments } = loadDemo();
    const half = segments.find((s) => s.seg.id === 'turn-to-window-halfroot')!;
    const full = segments.find((s) => s.seg.id === 'turn-to-window')!;

    const stopOf = (loaded: typeof half.loaded) => {
      const { trajectory } = extractRootMotion(skel, loaded);
      return trajectory.evaluate(loaded.duration, false);
    };
    const stopHalf = stopOf(half.loaded);
    const stopFull = stopOf(full.loaded);

    expect(stopHalf.x).toBeCloseTo(1.2, 5);
    expect(stopHalf.z).toBeCloseTo(3.7, 5);
    expect(stopFull.x).toBeCloseTo(2.4, 5);
    expect(stopFull.z).toBeCloseTo(4.6, 5);

    const mark = spec.stage.marks.find((m) => m.id === 'window')!;
    const deltaHalf = Math.hypot(stopHalf.x - mark.pos[0], stopHalf.z - mark.pos[2]);
    const deltaFull = Math.hypot(stopFull.x - mark.pos[0], stopFull.z - mark.pos[2]);
    expect(deltaHalf).toBeCloseTo(1.5, 5);
    expect(deltaFull).toBeLessThan(spec.tolerances.posM);

    // 朝向不受根位移缩放影响：两者落点朝向一致
    expect(Math.abs(stopHalf.yaw - stopFull.yaw)).toBeLessThan(1e-4);
  });
});

describe('执行证据入库：导出产物与重算一致', () => {
  it('verification.json 全绿且数值与现场重算一致', () => {
    const evidence = readJson(path.join(OUT_DIR, 'verification.json')) as {
      overallPass: boolean;
      checks: { pass: boolean }[];
      segments: { id: string; stopPos: number[]; rootDisplacement: number[]; markDelta: number }[];
    };
    expect(evidence.overallPass).toBe(true);
    expect(evidence.checks.length).toBeGreaterThan(0);
    expect(evidence.checks.every((c) => c.pass)).toBe(true);

    const { spec, skel, segments } = loadDemo();
    for (const { seg, asset, loaded, regenerated, mark } of segments) {
      const { evidence: fresh } = verifySegment({
        seg,
        fps: spec.fps,
        tolerances: spec.tolerances,
        skel,
        mark,
        asset,
        regenerated,
        loaded,
      });
      const recorded = evidence.segments.find((s) => s.id === seg.id)!;
      expect(recorded.stopPos[0]).toBeCloseTo(fresh.stopPos[0], 6);
      expect(recorded.stopPos[2]).toBeCloseTo(fresh.stopPos[2], 6);
      expect(recorded.rootDisplacement[0]).toBeCloseTo(fresh.rootDisplacement[0], 6);
      expect(recorded.rootDisplacement[2]).toBeCloseTo(fresh.rootDisplacement[2], 6);
      expect(recorded.markDelta).toBeCloseTo(fresh.markDelta, 6);
    }
  });

  it('轨迹数据导出：样本数与帧数一致，周期增量与轨迹自洽', () => {
    const { segments } = loadDemo();
    for (const { seg, loaded } of segments) {
      const traj = readJson(path.join(OUT_DIR, `trajectory-${seg.id}.json`)) as {
        format: string;
        units: string;
        samples: { x: number; y: number; z: number; yaw: number }[];
        cycle: { x: number; y: number; z: number; yaw: number };
      };
      expect(traj.format).toBe('blocking-previs/trajectory/1');
      expect(traj.units).toBe('m');
      expect(traj.samples).toHaveLength(loaded.frameCount);
      const first = traj.samples[0];
      const last = traj.samples[traj.samples.length - 1];
      expect(last.yaw - first.yaw).toBeCloseTo(traj.cycle.yaw, 6);
    }
  });

  it('场景导出可直接载入（blocking-previs/1），载入后轨迹求值一致', () => {
    const { segments } = loadDemo();
    const skel = buildSkeleton();
    for (const { seg, loaded } of segments) {
      const json = readFileSync(path.join(OUT_DIR, `blocking-previs-${seg.id}.json`), 'utf8');
      const restored = importScene(json);
      const { trajectory } = extractRootMotion(skel, loaded);
      for (const t of [0, 0.37, loaded.duration / 2, loaded.duration]) {
        const a = trajectory.evaluate(t, false);
        const b = restored.player.rootFrameAt(t);
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-5);
        expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-5);
      }
    }
  });

  it('预演视频真实存在且为有效 mp4', () => {
    const buf = readFileSync(path.join(OUT_DIR, 'previs.mp4'));
    expect(buf.length).toBeGreaterThan(50 * 1024);
    expect(buf.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });
});

describe('根运动旧样例运行到底', () => {
  it('全部内置样例：提取→跨周期求值→重组误差→导出→载入 全链路通过', () => {
    for (const key of Object.keys(CLIP_BUILDERS)) {
      const skel = buildSkeleton();
      const original = CLIP_BUILDERS[key](skel);
      const { trajectory, inPlace } = extractRootMotion(skel, original);
      const player = new Player(skel, inPlace, trajectory);
      player.loop = true;
      const T = original.duration;
      for (const t of [-2 * T - 0.4, -0.3, 0, 1.1, T, 2 * T + 0.7, 3 * T - 0.2]) {
        expect(recombineErrorAt(skel, original, player, t), `${key} @ t=${t}`).toBeLessThan(1e-3);
      }
      const restored = importScene(exportScene(player, original.name));
      const a = player.rootFrameAt(1.1);
      const b = restored.player.rootFrameAt(1.1);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-6);
    }
  });
});
