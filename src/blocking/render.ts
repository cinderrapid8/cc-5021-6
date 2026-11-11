import { CHAR_ADV, GLYPH_H, glyphFor, textWidth } from './font';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const rgb = (hex: number): Rgb => ({
  r: (hex >> 16) & 0xff,
  g: (hex >> 8) & 0xff,
  b: hex & 0xff,
});

/** RGBA 帧缓冲：软件光栅化（线、圆、点阵文字），供离线渲染预演帧。 */
export class FrameBuffer {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  clear(c: Rgb): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = c.r;
      this.data[i + 1] = c.g;
      this.data[i + 2] = c.b;
      this.data[i + 3] = 0xff;
    }
  }

  setPixel(x: number, y: number, c: Rgb): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const o = (yi * this.width + xi) * 4;
    this.data[o] = c.r;
    this.data[o + 1] = c.g;
    this.data[o + 2] = c.b;
    this.data[o + 3] = 0xff;
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(ax, ay, c);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, c: Rgb): void {
    const r = Math.max(1, Math.round(radius));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) this.setPixel(cx + dx, cy + dy, c);
      }
    }
  }

  text(x: number, y: number, str: string, c: Rgb, scale = 1): void {
    let pen = Math.round(x);
    const top = Math.round(y);
    for (const ch of str.toUpperCase()) {
      const glyph = glyphFor(ch);
      for (let col = 0; col < glyph.length; col++) {
        const bits = glyph[col];
        for (let row = 0; row < GLYPH_H; row++) {
          if ((bits >> row) & 1) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                this.setPixel(pen + col * scale + sx, top + row * scale + sy, c);
              }
            }
          }
        }
      }
      pen += CHAR_ADV * scale;
    }
  }

  textCentered(y: number, str: string, c: Rgb, scale = 1): void {
    this.text((this.width - textWidth(str, scale)) / 2, y, str, c, scale);
  }
}

export interface CamSpec {
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number; // 垂直视场角（度）
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 透视相机：position/lookAt/垂直 fov，输出屏幕坐标；点在近裁面后返回 null。 */
export class Camera {
  private readonly right: V3;
  private readonly upVec: V3;
  private readonly forward: V3;
  private readonly focal: number;

  constructor(
    readonly spec: CamSpec,
    width: number,
    height: number,
  ) {
    this.forward = norm(sub(spec.lookAt, spec.position));
    const worldUp: V3 = Math.abs(this.forward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    this.right = norm(cross(this.forward, worldUp));
    this.upVec = cross(this.right, this.forward);
    this.focal = height / 2 / Math.tan((spec.fov * Math.PI) / 360);
    this.cx = width / 2;
    this.cy = height / 2;
  }

  private readonly cx: number;
  private readonly cy: number;

  project(p: V3): [number, number] | null {
    const d = sub(p, this.spec.position);
    const z = dot(d, this.forward);
    if (z < 0.05) return null;
    const x = dot(d, this.right);
    const y = dot(d, this.upVec);
    return [this.cx + (x * this.focal) / z, this.cy - (y * this.focal) / z];
  }

  /** 三维折线：投影后逐段画线，任一端点不可见则跳过该段。 */
  polyline(fb: FrameBuffer, pts: V3[], c: Rgb): void {
    let prev: [number, number] | null = null;
    for (const p of pts) {
      const cur = this.project(p);
      if (prev && cur) fb.line(prev[0], prev[1], cur[0], cur[1], c);
      prev = cur;
    }
  }
}
