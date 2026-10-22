// Real-ESRGAN "animevideov3" (SRVGGNetCompact, ×4) running on the GPU through
// WebGPU compute shaders. Weights: official xinntao/Real-ESRGAN v0.2.5.0 release
// (BSD-3-Clause, see public/models/LICENSE-Real-ESRGAN.txt), converted to raw
// float32 by a stdlib-only script.
//
// Network: conv3x3(3→64) PReLU, 16 × [conv3x3(64→64) PReLU], conv3x3(64→48),
// pixel-shuffle ×4, plus the nearest-upsampled input. Images are processed in
// overlapping tiles: the margin (20 px) exceeds the network's 18 px receptive
// radius, so tile seams are exact.

const SCALE = 4;
const TILE = 160;
const MARGIN = 20;

interface Manifest {
  tensors: Array<{ name: string; shape: number[]; offset: number; length: number }>;
}

interface Layer {
  cin: number;
  cout: number;
  prelu: boolean;
  weights: GPUBuffer;
  bias: GPUBuffer;
  slope: GPUBuffer;
  uniform: GPUBuffer;
}

const CONV_WGSL = /* wgsl */ `
struct Dims { w: u32, h: u32, cin: u32, prelu: u32 };
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> inp: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> slope: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> outp: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  let o = gid.z;
  if (x >= dims.w || y >= dims.h) { return; }
  let plane = dims.w * dims.h;
  var acc = bias[o];
  for (var ic = 0u; ic < dims.cin; ic = ic + 1u) {
    let base = ic * plane;
    let wbase = (o * dims.cin + ic) * 9u;
    for (var ky = 0u; ky < 3u; ky = ky + 1u) {
      let yy = i32(y) + i32(ky) - 1;
      if (yy < 0 || yy >= i32(dims.h)) { continue; }
      let row = base + u32(yy) * dims.w;
      for (var kx = 0u; kx < 3u; kx = kx + 1u) {
        let xx = i32(x) + i32(kx) - 1;
        if (xx < 0 || xx >= i32(dims.w)) { continue; }
        acc = acc + inp[row + u32(xx)] * weights[wbase + ky * 3u + kx];
      }
    }
  }
  if (dims.prelu == 1u) {
    acc = select(acc * slope[o], acc, acc >= vec4<f32>(0.0));
  }
  let ob = o * 4u * plane + y * dims.w + x;
  outp[ob] = acc.x;
  outp[ob + plane] = acc.y;
  outp[ob + 2u * plane] = acc.z;
  outp[ob + 3u * plane] = acc.w;
}`;

const SHUFFLE_WGSL = /* wgsl */ `
struct S { w: u32, h: u32, cx0: u32, cy0: u32, cw: u32, ch: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> s: S;
@group(0) @binding(1) var<storage, read> feat: array<f32>;
@group(0) @binding(2) var<storage, read> inp: array<f32>;
@group(0) @binding(3) var<storage, read_write> outp: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ow = s.cw * 4u;
  let oh = s.ch * 4u;
  if (gid.x >= ow || gid.y >= oh) { return; }
  let lx = s.cx0 + gid.x / 4u;
  let ly = s.cy0 + gid.y / 4u;
  let i = gid.y % 4u;
  let j = gid.x % 4u;
  let plane = s.w * s.h;
  let p = ly * s.w + lx;
  for (var c = 0u; c < 3u; c = c + 1u) {
    let v = feat[(c * 16u + i * 4u + j) * plane + p] + inp[c * plane + p];
    outp[c * ow * oh + gid.y * ow + gid.x] = clamp(v, 0.0, 1.0);
  }
}`;

export interface UpscaleProgress {
  done: number;
  total: number;
}

export class EsrganUpscaler {
  private constructor(
    private device: GPUDevice,
    private layers: Layer[],
    private convPipeline: GPUComputePipeline,
    private shufflePipeline: GPUComputePipeline,
  ) {}

  static async create(modelBase: string): Promise<EsrganUpscaler> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU is not available in this browser');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
      },
    });

    const [manifest, blob] = await Promise.all([
      fetch(`${modelBase}.json`).then((r) => {
        if (!r.ok) throw new Error(`Model manifest missing (${r.status})`);
        return r.json() as Promise<Manifest>;
      }),
      fetch(`${modelBase}.bin`).then((r) => {
        if (!r.ok) throw new Error(`Model weights missing (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    const all = new Float32Array(blob);
    const tensor = (name: string) => {
      const t = manifest.tensors.find((x) => x.name === name);
      if (!t) throw new Error(`Model tensor ${name} missing`);
      return { data: all.subarray(t.offset, t.offset + t.length), shape: t.shape };
    };

    const storage = (data: Float32Array) => {
      const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
      return buf;
    };

    // body.{0,2,…,34} are convolutions, body.{1,3,…,33} PReLU slopes.
    const layers: Layer[] = [];
    for (let k = 0; k <= 34; k += 2) {
      const w = tensor(`body.${k}.weight`);
      const b = tensor(`body.${k}.bias`);
      const [cout, cin] = w.shape;
      const prelu = k < 34;
      // [oc][ic][ky][kx] → [oc/4][ic][k][4] so each invocation loads vec4 of 4 output channels.
      const packed = new Float32Array((cout / 4) * cin * 9 * 4);
      for (let oc = 0; oc < cout; oc++) {
        for (let ic = 0; ic < cin; ic++) {
          for (let kk = 0; kk < 9; kk++) {
            packed[(((oc >> 2) * cin + ic) * 9 + kk) * 4 + (oc & 3)] = w.data[(oc * cin + ic) * 9 + kk];
          }
        }
      }
      const slope = prelu ? tensor(`body.${k + 1}.weight`).data : new Float32Array(cout);
      layers.push({
        cin,
        cout,
        prelu,
        weights: storage(packed),
        bias: storage(new Float32Array(b.data)),
        slope: storage(new Float32Array(slope)),
        uniform: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      });
    }

    const convPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: CONV_WGSL }), entryPoint: 'main' },
    });
    const shufflePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SHUFFLE_WGSL }), entryPoint: 'main' },
    });
    return new EsrganUpscaler(device, layers, convPipeline, shufflePipeline);
  }

  /** ×4 upscale of an RGBA image. Alpha is upscaled by the caller if needed; output alpha is 255. */
  async upscale(rgba: Uint8ClampedArray, width: number, height: number, onProgress?: (p: UpscaleProgress) => void): Promise<Uint8ClampedArray> {
    const { device } = this;
    const span = TILE + 2 * MARGIN;
    const featBytes = 64 * span * span * 4;
    const make = (size: number, usage: number) => device.createBuffer({ size, usage });
    const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const input = make(3 * span * span * 4, STORAGE);
    const bufA = make(featBytes, STORAGE);
    const bufB = make(featBytes, STORAGE);
    const outBytes = 3 * (TILE * SCALE) * (TILE * SCALE) * 4;
    const out = make(outBytes, STORAGE);
    const readback = make(outBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const shuffleUniform = make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    const convGroups = this.layers.map((layer, k) =>
      device.createBindGroup({
        layout: this.convPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: layer.uniform } },
          { binding: 1, resource: { buffer: k === 0 ? input : k % 2 === 1 ? bufA : bufB } },
          { binding: 2, resource: { buffer: layer.weights } },
          { binding: 3, resource: { buffer: layer.bias } },
          { binding: 4, resource: { buffer: layer.slope } },
          { binding: 5, resource: { buffer: k % 2 === 0 ? bufA : bufB } },
        ],
      }),
    );
    const lastFeat = (this.layers.length - 1) % 2 === 0 ? bufA : bufB;
    const shuffleGroup = device.createBindGroup({
      layout: this.shufflePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: shuffleUniform } },
        { binding: 1, resource: { buffer: lastFeat } },
        { binding: 2, resource: { buffer: input } },
        { binding: 3, resource: { buffer: out } },
      ],
    });

    const OW = width * SCALE, OH = height * SCALE;
    const result = new Uint8ClampedArray(OW * OH * 4);
    const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE);
    const total = tilesX * tilesY;
    let done = 0;
    const planes = new Float32Array(3 * span * span);

    try {
      for (let ty = 0; ty < height; ty += TILE) {
        for (let tx = 0; tx < width; tx += TILE) {
          const cw = Math.min(TILE, width - tx), ch = Math.min(TILE, height - ty);
          const x0 = Math.max(0, tx - MARGIN), y0 = Math.max(0, ty - MARGIN);
          const x1 = Math.min(width, tx + cw + MARGIN), y1 = Math.min(height, ty + ch + MARGIN);
          const tw = x1 - x0, th = y1 - y0, plane = tw * th;
          for (let y = 0; y < th; y++) {
            for (let x = 0; x < tw; x++) {
              const i = ((y0 + y) * width + x0 + x) * 4;
              const p = y * tw + x;
              planes[p] = rgba[i] / 255;
              planes[plane + p] = rgba[i + 1] / 255;
              planes[2 * plane + p] = rgba[i + 2] / 255;
            }
          }
          device.queue.writeBuffer(input, 0, planes.buffer, 0, 3 * plane * 4);
          for (const layer of this.layers) {
            device.queue.writeBuffer(layer.uniform, 0, new Uint32Array([tw, th, layer.cin, layer.prelu ? 1 : 0]));
          }
          device.queue.writeBuffer(shuffleUniform, 0, new Uint32Array([tw, th, tx - x0, ty - y0, cw, ch, 0, 0]));

          const enc = device.createCommandEncoder();
          this.layers.forEach((layer, k) => {
            const pass = enc.beginComputePass();
            pass.setPipeline(this.convPipeline);
            pass.setBindGroup(0, convGroups[k]);
            pass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8), layer.cout / 4);
            pass.end();
          });
          const sp = enc.beginComputePass();
          sp.setPipeline(this.shufflePipeline);
          sp.setBindGroup(0, shuffleGroup);
          sp.dispatchWorkgroups(Math.ceil((cw * SCALE) / 8), Math.ceil((ch * SCALE) / 8), 1);
          sp.end();
          const ow = cw * SCALE, oh = ch * SCALE, bytes = 3 * ow * oh * 4;
          enc.copyBufferToBuffer(out, 0, readback, 0, bytes);
          device.queue.submit([enc.finish()]);

          await readback.mapAsync(GPUMapMode.READ, 0, bytes);
          const px = new Float32Array(readback.getMappedRange(0, bytes));
          const op = ow * oh;
          for (let y = 0; y < oh; y++) {
            let o = ((ty * SCALE + y) * OW + tx * SCALE) * 4;
            for (let x = 0; x < ow; x++, o += 4) {
              const p = y * ow + x;
              result[o] = px[p] * 255 + 0.5;
              result[o + 1] = px[op + p] * 255 + 0.5;
              result[o + 2] = px[2 * op + p] * 255 + 0.5;
              result[o + 3] = 255;
            }
          }
          readback.unmap();
          onProgress?.({ done: ++done, total });
        }
      }
    } finally {
      for (const b of [input, bufA, bufB, out, readback, shuffleUniform]) b.destroy();
    }
    return result;
  }
}
