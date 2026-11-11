import { Clip } from './clip';
import { TrajFrame } from './math';
import { Player } from './player';
import { Skeleton } from './skeleton';
import { Trajectory } from './trajectory';

export const EXPORT_FORMAT = 'blocking-previs/1';

export interface ExportData {
  format: string;
  clipName: string;
  skeleton: Skeleton;
  fps: number;
  duration: number;
  inPlace: { pos: number[]; quat: number[] };
  trajectory: { samples: TrajFrame[]; cycle: TrajFrame };
  player: { time: number; speed: number; loop: boolean };
}

/** 导出分离后的动画 + 轨迹 + 播放器状态为 JSON 字符串。 */
export function exportScene(player: Player, clipName: string): string {
  const clip = player.inPlace;
  const data: ExportData = {
    format: EXPORT_FORMAT,
    clipName,
    skeleton: player.skel,
    fps: clip.fps,
    duration: clip.duration,
    inPlace: {
      pos: Array.from(clip.pos),
      quat: Array.from(clip.quat),
    },
    trajectory: {
      samples: player.trajectory.samples,
      cycle: player.trajectory.cycle,
    },
    player: {
      time: player.time,
      speed: player.speed,
      loop: player.loop,
    },
  };
  return JSON.stringify(data);
}

export interface ImportedScene {
  skel: Skeleton;
  player: Player;
  clipName: string;
}

/** 从 JSON 还原分离后的动画与轨迹，校验格式与数据长度。 */
export function importScene(json: string): ImportedScene {
  const data = JSON.parse(json) as ExportData;
  if (data.format !== EXPORT_FORMAT) {
    throw new Error(`无法识别的格式: ${String(data.format)}（期望 ${EXPORT_FORMAT}）`);
  }
  const skel = data.skeleton;
  const boneCount = skel.bones.length;
  const frameCount = Math.round(data.duration * data.fps) + 1;
  if (data.inPlace.pos.length !== boneCount * frameCount * 3) {
    throw new Error('动画位置数据长度与骨架/帧数不符');
  }
  if (data.inPlace.quat.length !== boneCount * frameCount * 4) {
    throw new Error('动画旋转数据长度与骨架/帧数不符');
  }
  if (data.trajectory.samples.length !== frameCount) {
    throw new Error('轨迹样本数与动画帧数不符');
  }
  const inPlace: Clip = {
    name: `${data.clipName} (in-place)`,
    duration: data.duration,
    fps: data.fps,
    frameCount,
    boneCount,
    pos: Float32Array.from(data.inPlace.pos),
    quat: Float32Array.from(data.inPlace.quat),
  };
  const trajectory = new Trajectory(
    data.trajectory.samples,
    data.duration,
    data.fps,
    data.trajectory.cycle,
  );
  const player = new Player(skel, inPlace, trajectory);
  player.setTime(data.player.time);
  player.speed = data.player.speed;
  player.loop = data.player.loop;
  return { skel, player, clipName: data.clipName };
}
