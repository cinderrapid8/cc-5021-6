import { recombineErrorAt } from '../core/compare';
import { Clip } from '../core/clip';
import { extractRootMotion } from '../core/extract';
import { Player } from '../core/player';
import { Skeleton } from '../core/skeleton';
import {
  ClipAssetJson,
  SegmentSpec,
  StageMark,
  Tolerances,
  VERIFICATION_FORMAT,
  segmentSourceParams,
  stableStringify,
} from './project';

/**
 * 走位核验：把落点与根位移的声明值（工程清单 expect）和重建实测值逐项比对，
 * 输出结构化执行证据。任何一项超差都会让 overallPass = false，
 * 核验器本身不做任何静默修正。
 */

export interface CheckEvidence {
  segmentId: string;
  check: string;
  expected: string;
  actual: string;
  tolerance: string;
  pass: boolean;
}

export interface SegmentEvidence {
  id: string;
  durationSec: number;
  frameCount: number;
  stopPos: [number, number, number];
  stopYawDeg: number;
  /** 末帧减首帧的平面向量位移（米） */
  rootDisplacement: [number, number, number];
  netYawDeg: number;
  /** 循环周期增量 F(T)∘F(0)⁻¹：[x, y, z, yawDeg]，含旋转复合，与 rootDisplacement 语义不同 */
  cycleDelta: [number, number, number, number];
  markDelta: number;
  rawUnitsScale: number;
  recombineMaxError: number;
  reloadMaxDiff: number;
}

export interface ProjectEvidence {
  format: string;
  generatedAt: string;
  project: string;
  overallPass: boolean;
  checks: CheckEvidence[];
  segments: SegmentEvidence[];
}

const TWO_PI = Math.PI * 2;
const DEG = 180 / Math.PI;
const wrapPi = (a: number): number => {
  const m = (((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return m - Math.PI;
};

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const v3 = (v: { x: number; y: number; z: number }): [number, number, number] => [
  round6(v.x),
  round6(v.y),
  round6(v.z),
];
const fmt = (v: number[], digits = 6): string => `[${v.map((x) => x.toFixed(digits)).join(', ')}]`;

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

/** 根骨（bone 0）逐帧水平位置的最大模长，用于单位倍率实测。 */
function maxRootXZ(clipPos: ArrayLike<number>, frameCount: number): number {
  let max = 0;
  for (let f = 0; f < frameCount; f++) {
    const o = f * 3;
    max = Math.max(max, Math.hypot(clipPos[o], clipPos[o + 2]));
  }
  return max;
}

export interface SegmentVerifyInput {
  seg: SegmentSpec;
  fps: number;
  tolerances: Tolerances;
  skel: Skeleton;
  mark: StageMark;
  asset: ClipAssetJson;
  /** 由工程清单 moves重新编译的米制片段 */
  regenerated: Clip;
  /** 由素材文件载入并换算到米制的片段 */
  loaded: Clip;
}

export function verifySegment(input: SegmentVerifyInput): { checks: CheckEvidence[]; evidence: SegmentEvidence } {
  const { seg, fps, tolerances, skel, mark, asset, regenerated, loaded } = input;
  const checks: CheckEvidence[] = [];
  const add = (check: string, expected: string, actual: string, tolerance: string, pass: boolean): void => {
    checks.push({ segmentId: seg.id, check, expected, actual, tolerance, pass });
  };

  // 1. 来源参数：素材内记录的生成参数必须与工程清单一致
  const paramsAsset = stableStringify(asset.source.params);
  const paramsSpec = stableStringify(segmentSourceParams(seg, fps));
  add('source-params', paramsSpec, paramsAsset, 'exact', paramsAsset === paramsSpec);

  // 2. 可重建：按清单重编译的片段与素材载入结果逐值一致
  const reloadDiff = Math.max(
    maxAbsDiff(regenerated.pos, loaded.pos),
    maxAbsDiff(regenerated.quat, loaded.quat),
  );
  add('asset-reload', `<= ${tolerances.reloadDiff}`, reloadDiff.toExponential(3), `${tolerances.reloadDiff}`, reloadDiff <= tolerances.reloadDiff);

  // 3. 根运动提取 + 重组约定：重组姿态与原片段逐骨骼误差
  const { trajectory, inPlace } = extractRootMotion(skel, loaded);
  const player = new Player(skel, inPlace, trajectory);
  player.loop = false;
  let recombineMaxError = 0;
  for (let i = 0; i < loaded.frameCount; i += 7) {
    recombineMaxError = Math.max(recombineMaxError, recombineErrorAt(skel, loaded, player, i / loaded.fps));
  }
  for (let i = 0; i < loaded.frameCount - 1; i += 11) {
    recombineMaxError = Math.max(
      recombineMaxError,
      recombineErrorAt(skel, loaded, player, (i + 0.5) / loaded.fps),
    );
  }
  add(
    'recombine-error',
    `<= ${tolerances.recombineM}`,
    recombineMaxError.toExponential(3),
    `${tolerances.recombineM}`,
    recombineMaxError <= tolerances.recombineM,
  );

  // 4. 落点：轨迹终点位置与清单声明值
  const stop = trajectory.evaluate(loaded.duration, false);
  const stopErr = Math.hypot(
    stop.x - seg.expect.stopPos[0],
    stop.y - seg.expect.stopPos[1],
    stop.z - seg.expect.stopPos[2],
  );
  add(
    'stop-position',
    fmt(seg.expect.stopPos),
    fmt([stop.x, stop.y, stop.z]),
    `${tolerances.posM} m`,
    stopErr <= tolerances.posM,
  );

  // 5. 落点朝向（连续角度，模 2π 比较）
  const stopYawErrDeg = Math.abs(wrapPi(stop.yaw - seg.expect.stopYawDeg / DEG)) * DEG;
  add(
    'stop-yaw',
    `${seg.expect.stopYawDeg.toFixed(3)} deg`,
    `${(stop.yaw * DEG).toFixed(3)} deg`,
    `${tolerances.yawDeg} deg`,
    stopYawErrDeg <= tolerances.yawDeg,
  );

  // 6. 根位移：末帧减首帧的平面向量（用户可辨认的净位移），与清单声明值比对。
  // 注意区别于 trajectory.cycle（F(T)∘F(0)⁻¹ 的刚体复合）：含净转角时两者平移量不同，
  // 例如转身 180° 的片段，周期增量平移会多算一段旋转半径 —— 这正是需要辨认的设置差异。
  const first = trajectory.samples[0];
  const last = trajectory.samples[trajectory.samples.length - 1];
  const disp = {
    x: last.x - first.x,
    y: last.y - first.y,
    z: last.z - first.z,
  };
  const dispErr = Math.hypot(
    disp.x - seg.expect.rootDisplacement[0],
    disp.y - seg.expect.rootDisplacement[1],
    disp.z - seg.expect.rootDisplacement[2],
  );
  add(
    'root-displacement',
    fmt(seg.expect.rootDisplacement),
    fmt([disp.x, disp.y, disp.z]),
    `${tolerances.posM} m`,
    dispErr <= tolerances.posM,
  );

  // 7. 净转角（连续，度）：末帧连续偏航减首帧偏航
  const netYawDeg = (last.yaw - first.yaw) * DEG;
  const netYawErr = Math.abs(wrapPi(last.yaw - first.yaw - seg.expect.netYawDeg / DEG)) * DEG;
  add(
    'net-yaw',
    `${seg.expect.netYawDeg.toFixed(3)} deg`,
    `${netYawDeg.toFixed(3)} deg`,
    `${tolerances.yawDeg} deg`,
    netYawErr <= tolerances.yawDeg,
  );

  // 8. 循环一致性：周期增量复合求值（loop）与夹取求值在片段末端必须重合
  const loopEnd = trajectory.evaluate(loaded.duration, true);
  const cycleGap = Math.hypot(loopEnd.x - last.x, loopEnd.y - last.y, loopEnd.z - last.z);
  const cycleYawGapDeg = Math.abs(wrapPi(loopEnd.yaw - last.yaw)) * DEG;
  add(
    'cycle-consistency',
    fmt([last.x, last.y, last.z]),
    fmt([loopEnd.x, loopEnd.y, loopEnd.z]),
    `${tolerances.posM} m / ${tolerances.yawDeg} deg`,
    cycleGap <= tolerances.posM && cycleYawGapDeg <= tolerances.yawDeg,
  );

  // 9. 场景单位倍率：原始素材根骨模长 / 米制根骨模长，应等于声明的 rawUnitsScale
  const rawMax = maxRootXZ(asset.pos, asset.frameCount);
  const meterMax = maxRootXZ(Array.from(loaded.pos), loaded.frameCount);
  const measuredScale = meterMax > 1e-9 ? rawMax / meterMax : Number.NaN;
  const scaleRelErr = Math.abs(measuredScale / seg.expect.rawUnitsScale - 1);
  add(
    'units-scale',
    `x${seg.expect.rawUnitsScale}`,
    `x${round6(measuredScale)}`,
    'rel 1e-3',
    Number.isFinite(measuredScale) && scaleRelErr <= 1e-3,
  );

  // 10. 落点与舞台标记的距离：正常片段应贴标（0），对照片段应等于声明的差异量
  const markDelta = Math.hypot(stop.x - mark.pos[0], stop.z - mark.pos[2]);
  add(
    'mark-delta',
    `${seg.expect.markDeltaExpected.toFixed(3)} m`,
    `${markDelta.toFixed(6)} m`,
    `${tolerances.posM} m`,
    Math.abs(markDelta - seg.expect.markDeltaExpected) <= tolerances.posM,
  );

  const evidence: SegmentEvidence = {
    id: seg.id,
    durationSec: round6(loaded.duration),
    frameCount: loaded.frameCount,
    stopPos: v3(stop),
    stopYawDeg: round6(stop.yaw * DEG),
    rootDisplacement: v3(disp),
    netYawDeg: round6(netYawDeg),
    cycleDelta: [round6(trajectory.cycle.x), round6(trajectory.cycle.y), round6(trajectory.cycle.z), round6(trajectory.cycle.yaw * DEG)],
    markDelta: round6(markDelta),
    rawUnitsScale: round6(measuredScale),
    recombineMaxError,
    reloadMaxDiff: reloadDiff,
  };
  return { checks, evidence };
}

export function aggregateEvidence(
  project: string,
  generatedAt: string,
  results: { checks: CheckEvidence[]; evidence: SegmentEvidence }[],
): ProjectEvidence {
  const checks = results.flatMap((r) => r.checks);
  return {
    format: VERIFICATION_FORMAT,
    generatedAt,
    project,
    overallPass: checks.every((c) => c.pass),
    checks,
    segments: results.map((r) => r.evidence),
  };
}
