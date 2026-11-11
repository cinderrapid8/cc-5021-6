import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * 预演视频导出：帧序列（RGBA 原始数据）经管道送入 ffmpeg 编码为 mp4。
 * ffmpeg 缺失时显式报错并给出安装指引，不静默降级。
 */

export function resolveFfmpeg(explicitPath?: string): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`FFMPEG_PATH 指向的文件不存在: ${explicitPath}`);
    }
    return explicitPath;
  }
  if (process.env.FFMPEG_PATH) {
    return resolveFfmpeg(process.env.FFMPEG_PATH);
  }
  try {
    const req = createRequire(import.meta.url);
    const bundled = req('ffmpeg-static') as unknown;
    if (typeof bundled === 'string' && existsSync(bundled)) return bundled;
  } catch {
    // 未安装 ffmpeg-static，继续尝试系统 ffmpeg
  }
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return 'ffmpeg';
  throw new Error(FFMPEG_MISSING);
}

const FFMPEG_MISSING =
  '未找到 ffmpeg：请执行 npm i -D ffmpeg-static，或安装系统 ffmpeg，或设置 FFMPEG_PATH 指向可执行文件';

export interface VideoOptions {
  ffmpegPath: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
}

export async function encodeMp4(opts: VideoOptions, frames: Iterable<Uint8Array>): Promise<void> {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${opts.width}x${opts.height}`,
    '-r', String(opts.fps),
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '22',
    '-preset', 'veryfast',
    '-movflags', '+faststart',
    opts.outPath,
  ];
  const proc = spawn(opts.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderrChunks: Buffer[] = [];
  proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const exit = new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? -1));
  });

  for (const frame of frames) {
    if (frame.length !== opts.width * opts.height * 4) {
      proc.stdin.destroy();
      throw new Error(`帧大小不符: ${frame.length} 字节（期望 ${opts.width * opts.height * 4}）`);
    }
    if (!proc.stdin.write(frame)) {
      await new Promise<void>((resolve) => proc.stdin.once('drain', resolve));
    }
  }
  proc.stdin.end();

  const code = await exit;
  if (code !== 0) {
    const tail = Buffer.concat(stderrChunks).toString('utf8').split('\n').slice(-8).join('\n');
    throw new Error(`ffmpeg 编码失败（退出码 ${code}）:\n${tail}`);
  }
}
