import { Clip } from '../core/clip';
import { Skeleton } from '../core/skeleton';
import { Move, SegmentChoreography } from './choreography';

/**
 * 走位演示工程清单与素材的严格加载。
 * 原则：缺字段、类型不符、单位未声明一律抛错 —— 不用默认值遮错，
 * 让设置差异（场景单位、根位移缩放）只能显式声明、显式核验。
 */

export const PROJECT_FORMAT = 'blocking-previs/project/1';
export const CLIP_ASSET_FORMAT = 'blocking-previs/clip/1';
export const CAMERAS_FORMAT = 'blocking-previs/cameras/1';
export const TRAJECTORY_FORMAT = 'blocking-previs/trajectory/1';
export const VERIFICATION_FORMAT = 'blocking-previs/verification/1';

export type SceneUnits = 'm' | 'cm';

/** 场景单位 → 米。未声明或未知单位直接抛错。 */
export function unitToMeters(units: string): number {
  if (units === 'm') return 1;
  if (units === 'cm') return 0.01;
  throw new Error(`未识别的场景单位: ${String(units)}（仅支持 'm' | 'cm'）`);
}

export interface StageMark {
  id: string;
  label: string;
  pos: [number, number, number];
  facingDeg: number;
}

export interface SegmentExpect {
  /** 落点（米制，舞台坐标） */
  stopPos: [number, number, number];
  /** 落点朝向（连续角度，度） */
  stopYawDeg: number;
  /** 整段根位移（米制） */
  rootDisplacement: [number, number, number];
  /** 整段净转角（度，连续） */
  netYawDeg: number;
  /** 目标舞台标记 id */
  markId: string;
  /** 落点到标记的期望距离（米）：正常片段为 0，对照片段为声明的设置差异量 */
  markDeltaExpected: number;
  /** 原始素材相对米制的坐标倍率：cm 工程为 100，m 工程为 1 */
  rawUnitsScale: number;
}

export interface SegmentSpec extends SegmentChoreography {
  id: string;
  title: string;
  titleEn: string;
  units: SceneUnits;
  expect: SegmentExpect;
  /** 相对工程目录的片段素材路径 */
  clipAsset: string;
}

export interface StageSpec {
  name: string;
  units: 'm';
  /** [宽(x), 深(z)]，x ∈ [-w/2, w/2]，z ∈ [0, d] */
  size: [number, number];
  marks: StageMark[];
}

export interface Tolerances {
  posM: number;
  yawDeg: number;
  recombineM: number;
  reloadDiff: number;
}

export interface VideoSpec {
  fps: number;
  width: number;
  height: number;
  titleCardSec: number;
}

export interface ProjectSpec {
  name: string;
  description: string;
  skeleton: string;
  fps: number;
  stage: StageSpec;
  tolerances: Tolerances;
  segments: SegmentSpec[];
  camerasAsset: string;
  video: VideoSpec;
  source: { generator: string; createdAt: string; note: string };
}

export interface ShotMarker {
  id: string;
  segmentId: string;
  label: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
}

// ---------- 严格解析 ----------

const err = (msg: string): Error => new Error(`工程文件校验失败: ${msg}`);

function reqObj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw err(`${path} 应为对象`);
  return v as Record<string, unknown>;
}

function reqKeys(o: Record<string, unknown>, keys: string[], path: string): void {
  for (const k of keys) {
    if (!(k in o)) throw err(`${path} 缺少字段 "${k}"`);
  }
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw err(`${path} 含未识别字段 "${k}"`);
  }
}

function reqNum(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw err(`${path} 应为有限数值`);
  return v;
}

function reqStr(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw err(`${path} 应为非空字符串`);
  return v;
}

function reqNum3(v: unknown, path: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) throw err(`${path} 应为 3 元数组`);
  return [reqNum(v[0], `${path}[0]`), reqNum(v[1], `${path}[1]`), reqNum(v[2], `${path}[2]`)];
}

function reqNum2(v: unknown, path: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw err(`${path} 应为 2 元数组`);
  return [reqNum(v[0], `${path}[0]`), reqNum(v[1], `${path}[1]`)];
}

function reqUnits(v: unknown, path: string): SceneUnits {
  const s = reqStr(v, path);
  if (s !== 'm' && s !== 'cm') throw err(`${path} 单位必须显式声明为 'm' 或 'cm'，收到 "${s}"`);
  return s;
}

function parseMove(v: unknown, path: string): Move {
  const o = reqObj(v, path);
  const type = reqStr(o.type, `${path}.type`);
  if (type === 'walkTo') {
    reqKeys(o, ['type', 'to', 'speed'], path);
    return { type, to: reqNum2(o.to, `${path}.to`), speed: reqNum(o.speed, `${path}.speed`) };
  }
  if (type === 'turnTo') {
    const hasYaw = 'yawDeg' in o;
    const hasHeading = 'headingTo' in o;
    if (hasYaw === hasHeading) throw err(`${path} 必须且只能提供 yawDeg 或 headingTo 之一`);
    const allowed = ['type', 'yawRateDeg', 'direction', hasYaw ? 'yawDeg' : 'headingTo'];
    reqKeys(o, allowed, path);
    const direction = reqStr(o.direction, `${path}.direction`);
    if (direction !== 'cw' && direction !== 'ccw') {
      throw err(`${path}.direction 仅支持 'cw' | 'ccw'，收到 "${direction}"`);
    }
    const base: { type: 'turnTo'; yawRateDeg: number; direction: 'cw' | 'ccw' } = {
      type: 'turnTo',
      yawRateDeg: reqNum(o.yawRateDeg, `${path}.yawRateDeg`),
      direction,
    };
    return hasYaw
      ? { ...base, yawDeg: reqNum(o.yawDeg, `${path}.yawDeg`) }
      : { ...base, headingTo: reqNum2(o.headingTo, `${path}.headingTo`) };
  }
  if (type === 'wait') {
    reqKeys(o, ['type', 'duration'], path);
    return { type, duration: reqNum(o.duration, `${path}.duration`) };
  }
  throw err(`${path}.type 未知动作类型 "${type}"`);
}

function parseExpect(v: unknown, path: string): SegmentExpect {
  const o = reqObj(v, path);
  reqKeys(
    o,
    ['stopPos', 'stopYawDeg', 'rootDisplacement', 'netYawDeg', 'markId', 'markDeltaExpected', 'rawUnitsScale'],
    path,
  );
  return {
    stopPos: reqNum3(o.stopPos, `${path}.stopPos`),
    stopYawDeg: reqNum(o.stopYawDeg, `${path}.stopYawDeg`),
    rootDisplacement: reqNum3(o.rootDisplacement, `${path}.rootDisplacement`),
    netYawDeg: reqNum(o.netYawDeg, `${path}.netYawDeg`),
    markId: reqStr(o.markId, `${path}.markId`),
    markDeltaExpected: reqNum(o.markDeltaExpected, `${path}.markDeltaExpected`),
    rawUnitsScale: reqNum(o.rawUnitsScale, `${path}.rawUnitsScale`),
  };
}

export function parseProject(data: unknown): ProjectSpec {
  const o = reqObj(data, 'project');
  reqKeys(
    o,
    ['format', 'name', 'description', 'skeleton', 'fps', 'stage', 'tolerances', 'segments', 'camerasAsset', 'video', 'source'],
    'project',
  );
  const format = reqStr(o.format, 'project.format');
  if (format !== PROJECT_FORMAT) throw err(`project.format 无法识别: "${format}"（期望 ${PROJECT_FORMAT}）`);

  const stageO = reqObj(o.stage, 'project.stage');
  reqKeys(stageO, ['name', 'units', 'size', 'marks'], 'project.stage');
  const stageUnits = reqUnits(stageO.units, 'project.stage.units');
  if (stageUnits !== 'm') throw err('project.stage.units 必须为 m（舞台基准单位）');
  const size = reqNum2(stageO.size, 'project.stage.size');
  const marksRaw = stageO.marks;
  if (!Array.isArray(marksRaw) || marksRaw.length === 0) throw err('project.stage.marks 应为非空数组');
  const marks: StageMark[] = marksRaw.map((mv: unknown, i: number) => {
    const p = `project.stage.marks[${i}]`;
    const mo = reqObj(mv, p);
    reqKeys(mo, ['id', 'label', 'pos', 'facingDeg'], p);
    return {
      id: reqStr(mo.id, `${p}.id`),
      label: reqStr(mo.label, `${p}.label`),
      pos: reqNum3(mo.pos, `${p}.pos`),
      facingDeg: reqNum(mo.facingDeg, `${p}.facingDeg`),
    };
  });
  const markIds = new Set(marks.map((m) => m.id));
  if (markIds.size !== marks.length) throw err('project.stage.marks 存在重复 id');

  const tolO = reqObj(o.tolerances, 'project.tolerances');
  reqKeys(tolO, ['posM', 'yawDeg', 'recombineM', 'reloadDiff'], 'project.tolerances');
  const tolerances: Tolerances = {
    posM: reqNum(tolO.posM, 'project.tolerances.posM'),
    yawDeg: reqNum(tolO.yawDeg, 'project.tolerances.yawDeg'),
    recombineM: reqNum(tolO.recombineM, 'project.tolerances.recombineM'),
    reloadDiff: reqNum(tolO.reloadDiff, 'project.tolerances.reloadDiff'),
  };

  const segmentsRaw = o.segments;
  if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) throw err('project.segments 应为非空数组');
  const segments: SegmentSpec[] = segmentsRaw.map((sv: unknown, i: number) => {
    const p = `project.segments[${i}]`;
    const so = reqObj(sv, p);
    reqKeys(
      so,
      ['id', 'title', 'titleEn', 'units', 'rootScale', 'start', 'moves', 'expect', 'clipAsset'],
      p,
    );
    const startO = reqObj(so.start, `${p}.start`);
    reqKeys(startO, ['pos', 'yawDeg'], `${p}.start`);
    const movesRaw = so.moves;
    if (!Array.isArray(movesRaw) || movesRaw.length === 0) throw err(`${p}.moves 应为非空数组`);
    const spec: SegmentSpec = {
      id: reqStr(so.id, `${p}.id`),
      title: reqStr(so.title, `${p}.title`),
      titleEn: reqStr(so.titleEn, `${p}.titleEn`),
      units: reqUnits(so.units, `${p}.units`),
      rootScale: reqNum(so.rootScale, `${p}.rootScale`),
      start: {
        pos: reqNum3(startO.pos, `${p}.start.pos`),
        yawDeg: reqNum(startO.yawDeg, `${p}.start.yawDeg`),
      },
      moves: movesRaw.map((mv: unknown, j: number) => parseMove(mv, `${p}.moves[${j}]`)),
      expect: parseExpect(so.expect, `${p}.expect`),
      clipAsset: reqStr(so.clipAsset, `${p}.clipAsset`),
    };
    if (!markIds.has(spec.expect.markId)) {
      throw err(`${p}.expect.markId "${spec.expect.markId}" 未在舞台标记中声明`);
    }
    return spec;
  });
  const segIds = new Set(segments.map((s) => s.id));
  if (segIds.size !== segments.length) throw err('project.segments 存在重复 id');

  const videoO = reqObj(o.video, 'project.video');
  reqKeys(videoO, ['fps', 'width', 'height', 'titleCardSec'], 'project.video');
  const video: VideoSpec = {
    fps: reqNum(videoO.fps, 'project.video.fps'),
    width: reqNum(videoO.width, 'project.video.width'),
    height: reqNum(videoO.height, 'project.video.height'),
    titleCardSec: reqNum(videoO.titleCardSec, 'project.video.titleCardSec'),
  };

  const srcO = reqObj(o.source, 'project.source');
  reqKeys(srcO, ['generator', 'createdAt', 'note'], 'project.source');

  return {
    name: reqStr(o.name, 'project.name'),
    description: reqStr(o.description, 'project.description'),
    skeleton: reqStr(o.skeleton, 'project.skeleton'),
    fps: reqNum(o.fps, 'project.fps'),
    stage: { name: reqStr(stageO.name, 'project.stage.name'), units: 'm', size, marks },
    tolerances,
    segments,
    camerasAsset: reqStr(o.camerasAsset, 'project.camerasAsset'),
    video,
    source: {
      generator: reqStr(srcO.generator, 'project.source.generator'),
      createdAt: reqStr(srcO.createdAt, 'project.source.createdAt'),
      note: reqStr(srcO.note, 'project.source.note'),
    },
  };
}

export function parseCameras(data: unknown, segmentIds: ReadonlySet<string>): ShotMarker[] {
  const o = reqObj(data, 'cameras');
  reqKeys(o, ['format', 'shots'], 'cameras');
  const format = reqStr(o.format, 'cameras.format');
  if (format !== CAMERAS_FORMAT) throw err(`cameras.format 无法识别: "${format}"（期望 ${CAMERAS_FORMAT}）`);
  const shotsRaw = o.shots;
  if (!Array.isArray(shotsRaw) || shotsRaw.length === 0) throw err('cameras.shots 应为非空数组');
  return shotsRaw.map((sv: unknown, i: number) => {
    const p = `cameras.shots[${i}]`;
    const so = reqObj(sv, p);
    reqKeys(so, ['id', 'segmentId', 'label', 'position', 'lookAt', 'fov'], p);
    const segmentId = reqStr(so.segmentId, `${p}.segmentId`);
    if (!segmentIds.has(segmentId)) throw err(`${p}.segmentId "${segmentId}" 未在工程片段中声明`);
    const fov = reqNum(so.fov, `${p}.fov`);
    if (fov <= 0 || fov >= 150) throw err(`${p}.fov 超出合理范围: ${fov}`);
    return {
      id: reqStr(so.id, `${p}.id`),
      segmentId,
      label: reqStr(so.label, `${p}.label`),
      position: reqNum3(so.position, `${p}.position`),
      lookAt: reqNum3(so.lookAt, `${p}.lookAt`),
      fov,
    };
  });
}

// ---------- 片段素材（可重建动画数据） ----------

export interface ClipAssetSource {
  generator: string;
  createdAt: string;
  /** 生成参数（编排动作、起点、rootScale、单位、fps），与工程清单一致方可通过核验 */
  params: unknown;
}

export interface ClipAssetJson {
  format: string;
  name: string;
  units: SceneUnits;
  fps: number;
  duration: number;
  frameCount: number;
  bones: string[];
  pos: number[];
  quat: number[];
  source: ClipAssetSource;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** 米制片段 → 指定单位的素材 JSON（位置按单位缩放，数值保留 6 位小数）。 */
export function clipToAsset(clip: Clip, skel: Skeleton, units: SceneUnits, source: ClipAssetSource): string {
  const scale = 1 / unitToMeters(units);
  const asset: ClipAssetJson = {
    format: CLIP_ASSET_FORMAT,
    name: clip.name,
    units,
    fps: clip.fps,
    duration: round6(clip.duration),
    frameCount: clip.frameCount,
    bones: skel.bones.map((b) => b.name),
    pos: Array.from(clip.pos, (v) => round6(v * scale)),
    quat: Array.from(clip.quat, round6),
    source,
  };
  return `${JSON.stringify(asset)}\n`;
}

export function parseClipAsset(data: unknown, skel: Skeleton): ClipAssetJson {
  const o = reqObj(data, 'clipAsset');
  reqKeys(
    o,
    ['format', 'name', 'units', 'fps', 'duration', 'frameCount', 'bones', 'pos', 'quat', 'source'],
    'clipAsset',
  );
  const format = reqStr(o.format, 'clipAsset.format');
  if (format !== CLIP_ASSET_FORMAT) {
    throw err(`clipAsset.format 无法识别: "${format}"（期望 ${CLIP_ASSET_FORMAT}）`);
  }
  const units = reqUnits(o.units, 'clipAsset.units');
  const fps = reqNum(o.fps, 'clipAsset.fps');
  const duration = reqNum(o.duration, 'clipAsset.duration');
  const frameCount = reqNum(o.frameCount, 'clipAsset.frameCount');
  if (!Number.isInteger(frameCount) || frameCount < 2) throw err('clipAsset.frameCount 应为 ≥2 的整数');
  if (Math.round(duration * fps) + 1 !== frameCount) {
    throw err(`clipAsset 时长/帧率与帧数不符: round(${duration}×${fps})+1 ≠ ${frameCount}`);
  }
  const bonesRaw = o.bones;
  if (!Array.isArray(bonesRaw)) throw err('clipAsset.bones 应为数组');
  const bones = bonesRaw.map((b: unknown, i: number) => reqStr(b, `clipAsset.bones[${i}]`));
  const expected = skel.bones.map((b) => b.name);
  if (bones.length !== expected.length || bones.some((b, i) => b !== expected[i])) {
    throw err('clipAsset.bones 与骨架 walker14 的骨骼顺序不符');
  }
  const boneCount = bones.length;
  const posRaw = o.pos;
  const quatRaw = o.quat;
  if (!Array.isArray(posRaw) || posRaw.length !== boneCount * frameCount * 3) {
    throw err(`clipAsset.pos 长度应为 ${boneCount * frameCount * 3}，收到 ${Array.isArray(posRaw) ? posRaw.length : '非数组'}`);
  }
  if (!Array.isArray(quatRaw) || quatRaw.length !== boneCount * frameCount * 4) {
    throw err(`clipAsset.quat 长度应为 ${boneCount * frameCount * 4}，收到 ${Array.isArray(quatRaw) ? quatRaw.length : '非数组'}`);
  }
  const pos = posRaw.map((v: unknown, i: number) => reqNum(v, `clipAsset.pos[${i}]`));
  const quat = quatRaw.map((v: unknown, i: number) => reqNum(v, `clipAsset.quat[${i}]`));
  const srcO = reqObj(o.source, 'clipAsset.source');
  reqKeys(srcO, ['generator', 'createdAt', 'params'], 'clipAsset.source');
  return {
    format,
    name: reqStr(o.name, 'clipAsset.name'),
    units,
    fps,
    duration,
    frameCount,
    bones,
    pos,
    quat,
    source: {
      generator: reqStr(srcO.generator, 'clipAsset.source.generator'),
      createdAt: reqStr(srcO.createdAt, 'clipAsset.source.createdAt'),
      params: srcO.params,
    },
  };
}

/** 素材 JSON → 米制片段（按声明单位换算；单位未声明在解析阶段已被拒绝）。 */
export function clipFromAsset(asset: ClipAssetJson, skel: Skeleton): Clip {
  const scale = unitToMeters(asset.units);
  const clip: Clip = {
    name: asset.name,
    duration: asset.duration,
    fps: asset.fps,
    frameCount: asset.frameCount,
    boneCount: skel.bones.length,
    pos: Float32Array.from(asset.pos, (v) => v * scale),
    quat: Float32Array.from(asset.quat),
  };
  return clip;
}

/** 稳定序列化（键排序），用于来源参数的一致性比对。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** 片段素材 source.params 的规范形态：烘焙与核验共用同一构造函数，防止两处漂移。 */
export function segmentSourceParams(seg: SegmentSpec, fps: number): Record<string, unknown> {
  return {
    segmentId: seg.id,
    units: seg.units,
    rootScale: seg.rootScale,
    fps,
    start: seg.start,
    moves: seg.moves,
  };
}
