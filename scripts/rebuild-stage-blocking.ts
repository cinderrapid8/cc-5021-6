import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRootMotion } from '../src/core/extract';
import { Player } from '../src/core/player';
import { exportScene } from '../src/core/serialize';
import { buildSkeleton } from '../src/core/testClips';
import { compileSegmentClip } from '../src/blocking/choreography';
import {
  ClipAssetJson,
  ProjectSpec,
  SegmentSpec,
  TRAJECTORY_FORMAT,
  clipFromAsset,
  clipToAsset,
  parseCameras,
  parseClipAsset,
  parseProject,
  segmentSourceParams,
} from '../src/blocking/project';
import { FrameBuffer, rgb } from '../src/blocking/render';
import { StageFrameInput, renderStageFrame } from '../src/blocking/stageRender';
import { aggregateEvidence, verifySegment } from '../src/blocking/verify';
import { encodeMp4, resolveFfmpeg } from '../src/blocking/video';

/**
 * 走位演示工程重建脚本：
 *   1. 严格加载工程清单与镜头标记（缺字段/未声明单位即失败）
 *   2. 按清单参数重编译各片段（--bake 时同时重写素材文件）
 *   3. 逐项核验：来源参数、可重建性、重组误差、落点、根位移、单位倍率、标记偏差
 *   4. 导出执行证据（verification.json）、轨迹数据（json/csv）、UI 可载入的场景 json
 *   5. 渲染预演视频 previs.mp4
 * 任何核验失败都会以非零码退出；不存在用默认值继续的通路。
 */

interface Args {
  bake: boolean;
  project: string;
  out?: string;
  noVideo: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    bake: false,
    project: 'demo/stage-blocking/project.json',
    noVideo: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bake') args.bake = true;
    else if (a === '--no-video') args.noVideo = true;
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

const GENERATOR_ID = 'scripts/rebuild-stage-blocking.ts';

function loadSegmentAsset(
  seg: SegmentSpec,
  projectDir: string,
  spec: ProjectSpec,
  skel: ReturnType<typeof buildSkeleton>,
  bake: boolean,
): ClipAssetJson {
  const assetPath = path.join(projectDir, seg.clipAsset);
  if (bake) {
    const clip = compileSegmentClip(seg, skel, spec.fps, seg.id);
    const json = clipToAsset(clip, skel, seg.units, {
      generator: `${GENERATOR_ID} (via src/blocking/choreography.ts)`,
      createdAt: new Date().toISOString(),
      params: segmentSourceParams(seg, spec.fps),
    });
    mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, json);
  }
  let raw: string;
  try {
    raw = readFileSync(assetPath, 'utf8');
  } catch {
    throw new Error(`片段素材不存在: ${assetPath}（先以 --bake 生成）`);
  }
  return parseClipAsset(JSON.parse(raw), skel);
}

function segmentTag(seg: SegmentSpec): string {
  const tags = [`UNITS:${seg.units.toUpperCase()}`];
  if (seg.units === 'cm') tags.push('RAW X100');
  if (seg.rootScale !== 1) tags.push(`ROOT X${seg.rootScale}`);
  return tags.join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectPath = path.resolve(args.project);
  const projectDir = path.dirname(projectPath);
  const outDir = path.resolve(args.out ?? path.join(projectDir, 'out'));
  mkdirSync(outDir, { recursive: true });

  const spec = parseProject(JSON.parse(readFileSync(projectPath, 'utf8')));
  const skel = buildSkeleton();
  if (spec.skeleton !== 'walker14') {
    throw new Error(`工程声明的骨架 "${spec.skeleton}" 未知（本工具仅提供 walker14）`);
  }
  const segmentIds = new Set(spec.segments.map((s) => s.id));
  const shots = parseCameras(
    JSON.parse(readFileSync(path.join(projectDir, spec.camerasAsset), 'utf8')),
    segmentIds,
  );

  console.log(`工程: ${spec.name}  舞台: ${spec.stage.name}  片段数: ${spec.segments.length}`);
  if (args.bake) console.log('模式: --bake（按清单参数重写片段素材）');

  // ---- 逐片段：编译/载入/核验/导出 ----
  const results: { checks: import('../src/blocking/verify').CheckEvidence[]; evidence: import('../src/blocking/verify').SegmentEvidence }[] = [];
  const players = new Map<string, Player>();
  const trajLines = new Map<string, [number, number, number][]>();
  const csvRows: string[] = ['segment,t,x,y,z,yaw_deg,speed_mps'];

  for (const seg of spec.segments) {
    const regenerated = compileSegmentClip(seg, skel, spec.fps, seg.id);
    const asset = loadSegmentAsset(seg, projectDir, spec, skel, args.bake);
    const loaded = clipFromAsset(asset, skel);
    const mark = spec.stage.marks.find((m) => m.id === seg.expect.markId);
    if (!mark) throw new Error(`内部错误：标记 ${seg.expect.markId} 未通过清单校验`);

    const result = verifySegment({ seg, fps: spec.fps, tolerances: spec.tolerances, skel, mark, asset, regenerated, loaded });
    results.push(result);

    const { trajectory, inPlace } = extractRootMotion(skel, loaded);
    const player = new Player(skel, inPlace, trajectory);
    player.loop = false;
    player.speed = 1;
    player.setTime(0);
    players.set(seg.id, player);

    // 轨迹数据导出（米制）
    const trajExport = {
      format: TRAJECTORY_FORMAT,
      segmentId: seg.id,
      units: 'm',
      fps: trajectory.fps,
      duration: trajectory.duration,
      samples: trajectory.samples,
      cycle: trajectory.cycle,
      source: {
        project: spec.name,
        clipAsset: seg.clipAsset,
        generator: GENERATOR_ID,
      },
    };
    writeFileSync(path.join(outDir, `trajectory-${seg.id}.json`), `${JSON.stringify(trajExport, null, 2)}\n`);

    for (let f = 0; f < trajectory.samples.length; f++) {
      const t = f / trajectory.fps;
      const s = trajectory.samples[f];
      const rate = player.rootMotionRateAt(t);
      csvRows.push(
        `${seg.id},${t.toFixed(4)},${s.x.toFixed(6)},${s.y.toFixed(6)},${s.z.toFixed(6)},${((s.yaw * 180) / Math.PI).toFixed(4)},${rate.speed.toFixed(4)}`,
      );
    }

    // UI 可直接载入的场景文件（blocking-previs/1）
    writeFileSync(path.join(outDir, `blocking-previs-${seg.id}.json`), exportScene(player, seg.title));

    trajLines.set(
      seg.id,
      trajectory.bakePoints(0, trajectory.duration, trajectory.duration / 200, false).map((p) => [p.x, p.y + 0.02, p.z]),
    );
  }
  writeFileSync(path.join(outDir, 'trajectories.csv'), `${csvRows.join('\n')}\n`);

  // ---- 执行证据 ----
  const evidence = aggregateEvidence(spec.name, new Date().toISOString(), results);
  writeFileSync(path.join(outDir, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  console.log('\n片段核验：');
  for (const seg of spec.segments) {
    const ev = evidence.segments.find((s) => s.id === seg.id)!;
    const segChecks = evidence.checks.filter((c) => c.segmentId === seg.id);
    const failed = segChecks.filter((c) => !c.pass);
    const status = failed.length === 0 ? 'PASS' : `FAIL(${failed.map((c) => c.check).join(',')})`;
    console.log(
      `  ${seg.id.padEnd(28)} 落点=(${ev.stopPos.join(', ')}) 朝向=${ev.stopYawDeg}° ` +
        `根位移=(${ev.rootDisplacement.join(', ')}) 标记偏差=${ev.markDelta}m 重组误差=${(ev.recombineMaxError * 1000).toFixed(3)}mm ${status}`,
    );
  }
  console.log(`\n证据: ${path.join(outDir, 'verification.json')}`);
  console.log(`轨迹: ${path.join(outDir, 'trajectory-<片段>.json')} 与 trajectories.csv`);
  console.log(`场景: ${path.join(outDir, 'blocking-previs-<片段>.json')}（预演工具“载入”可直接打开）`);

  // ---- 预演视频 ----
  if (!args.noVideo) {
    const ffmpeg = resolveFfmpeg();
    const videoPath = path.join(outDir, 'previs.mp4');
    const { width, height, fps: vfps, titleCardSec } = spec.video;
    const fb = new FrameBuffer(width, height);
    const trajColors = [rgb(0x53d769), rgb(0x4aa3ff), rgb(0xffa54a), rgb(0xb98cff), rgb(0xff6a6a)];
    const frames: Uint8Array[] = [];

    const pushFrame = (): void => {
      frames.push(Uint8Array.from(fb.data));
    };

    spec.segments.forEach((seg, segIndex) => {
      const shot = shots.find((s) => s.segmentId === seg.id);
      if (!shot) throw new Error(`片段 ${seg.id} 缺少镜头标记`);
      const player = players.get(seg.id)!;
      const mark = spec.stage.marks.find((m) => m.id === seg.expect.markId)!;
      const trajectories = spec.segments.map((s, i) => ({
        pts: trajLines.get(s.id)!,
        color: trajColors[i % trajColors.length],
        active: s.id === seg.id,
      }));
      const marks = spec.stage.marks.map((m) => ({
        pos: m.pos,
        label: m.label,
        target: m.id === seg.expect.markId,
      }));

      for (let k = 0; k < Math.round(titleCardSec * vfps); k++) {
        renderStageFrame(fb, {
          camera: shot,
          stageSize: spec.stage.size,
          marks,
          trajectories,
          boneLines: [],
          joints: [],
          root: { pos: seg.start.pos, yaw: (seg.start.yawDeg * Math.PI) / 180 },
          hud: [],
          titleCard: [
            `SHOT ${segIndex + 1}/${spec.segments.length}`,
            seg.titleEn,
            segmentTag(seg),
            `MARK ${mark.label}`,
          ],
        });
        pushFrame();
      }

      const frameTotal = Math.round(player.duration * vfps);
      for (let k = 0; k <= frameTotal; k++) {
        const t = Math.min(k / vfps, player.duration);
        const world = player.worldPoseAt(t);
        const boneLines: [ [number, number, number], [number, number, number] ][] = [];
        for (let b = 0; b < skel.bones.length; b++) {
          const parent = skel.bones[b].parent;
          if (parent >= 0) {
            boneLines.push([
              [world.pos[parent].x, world.pos[parent].y, world.pos[parent].z],
              [world.pos[b].x, world.pos[b].y, world.pos[b].z],
            ]);
          }
        }
        const joints = world.pos.map((p) => [p.x, p.y, p.z] as [number, number, number]);
        const rootFrame = player.rootFrameAt(t);
        const distToMark = Math.hypot(rootFrame.x - mark.pos[0], rootFrame.z - mark.pos[2]);
        const input: StageFrameInput = {
          camera: shot,
          stageSize: spec.stage.size,
          marks,
          trajectories,
          boneLines,
          joints,
          root: { pos: [rootFrame.x, rootFrame.y, rootFrame.z], yaw: rootFrame.yaw },
          hud: [
            'STAGE-BLOCKING PREVIS',
            `${shot.label}  T=${t.toFixed(2)}S`,
            `SEG ${seg.id}`,
            segmentTag(seg),
            `TARGET ${mark.label} D=${distToMark.toFixed(2)}M`,
          ],
        };
        renderStageFrame(fb, input);
        pushFrame();
      }
    });

    console.log(`\n渲染预演视频: ${frames.length} 帧 → ${videoPath}`);
    await encodeMp4({ ffmpegPath: ffmpeg, outPath: videoPath, width, height, fps: vfps }, frames);
  }

  if (!evidence.overallPass) {
    console.error('\n核验未通过：存在超差检查项，详见 verification.json');
    process.exitCode = 1;
    return;
  }
  console.log('\n全部核验通过。');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
