import {
  TrajFrame,
  trajCompose,
  trajIdentity,
  trajInverse,
  trajLerp,
  trajPow,
} from './math';

/**
 * 根运动轨迹：一个循环周期内逐帧采样的位置 + 连续偏航角，
 * 以及整周期的复合增量 cycle（用于循环播放时累计周期位移）。
 * evaluate(t) 是纯函数：任意时刻（含倒放 t<0）都可直接求值，无需从头模拟。
 */
export class Trajectory {
  constructor(
    public readonly samples: TrajFrame[], // frameCount 个，覆盖 [0, duration]
    public readonly duration: number,
    public readonly fps: number,
    public readonly cycle: TrajFrame,
  ) {}

  /** 循环模式：t 可任意（含负值）；非循环：夹到 [0, duration]。 */
  evaluate(t: number, loop: boolean): TrajFrame {
    if (!loop) {
      return this.sampleAt(Math.min(Math.max(t, 0), this.duration));
    }
    const n = Math.floor(t / this.duration);
    const tau = t - n * this.duration;
    return trajCompose(trajPow(this.cycle, n), this.sampleAt(tau));
  }

  /** 周期内插值采样，tau ∈ [0, duration]。 */
  sampleAt(tau: number): TrajFrame {
    const s = Math.min(Math.max(tau, 0), this.duration) * this.fps;
    const i = Math.min(Math.floor(s), this.samples.length - 2);
    const f = Math.min(Math.max(s - i, 0), 1);
    return trajLerp(this.samples[i], this.samples[i + 1], f);
  }

  /** 由逐帧样本构建，自动计算周期增量 cycle = F(T) ∘ F(0)⁻¹。 */
  static fromSamples(samples: TrajFrame[], duration: number, fps: number): Trajectory {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const cycle = trajCompose(last, trajInverse(first));
    return new Trajectory(samples, duration, fps, cycle);
  }

  /** 展开成 [t0, t1] 的折线点（含循环累计），供 UI 画路径。 */
  bakePoints(t0: number, t1: number, step: number, loop: boolean): TrajFrame[] {
    const pts: TrajFrame[] = [];
    const count = Math.max(2, Math.ceil((t1 - t0) / step) + 1);
    for (let i = 0; i < count; i++) {
      pts.push(this.evaluate(t0 + (i / (count - 1)) * (t1 - t0), loop));
    }
    return pts;
  }
}

export { trajIdentity };
