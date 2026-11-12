// Daytona USA 2 WebGPU renderer (Claude 2026-11-11).
// JS half of the render port: consumes the per-field frame packet prepared in
// WASM by web/native/web_bridge.cpp (scene vertices, viewports with their
// draw decisions, dirty texture rows, 2D layers) and draws it the way
// LostWorldNative r3d_renderer.cpp record_world + compose do for Daytona 2.
// Optimizations kept from native: vertex upload only for new scenes, texture
// RAM upload by changed row runs, 2D layers only when recomposed, one uniform
// upload per frame (dynamic offsets), render targets sized to the window.

const SCREEN_W = 496, SCREEN_H = 384, BACK_W = 896;
const TILEGEN_SIZE = 0x190000, TILE_CHUNK = 4096, TILE_CHUNKS = TILEGEN_SIZE / TILE_CHUNK;
const VERTEX_BYTES = 80, VIEWPORT_FLOATS = 56, DRAW_STRIDE = 256;
// GPU vertex transform (web_bridge.cpp WebFrame 29..38, r3d_scene.h): refs,
// model-space vertices kept across frames, instances, colour-table entries.
const PACKET_WORDS = 39, REF_BYTES = 8, STATIC_BYTES = 96, INSTANCE_BYTES = 80;

export function computeLayout(winW, winH, maxAspect) {   // r3d_renderer.cpp compute_layout
  const aspect = winH > 0 ? winW / winH : 4 / 3;
  const maxW = SCREEN_H * Math.max(maxAspect, SCREEN_W / SCREEN_H);
  const viewW = Math.min(Math.max(SCREEN_H * aspect, SCREEN_W), maxW);
  const scale = Math.min(winW / viewW, winH / SCREEN_H);
  return { viewW, scale, ox: (winW - viewW * scale) / 2, oy: (winH - SCREEN_H * scale) / 2, gameX0: (viewW - SCREEN_W) / 2 };
}

export class Daytona2Renderer {
  static async create(canvas, shaderBase = './shaders/', { gpuTilegen = true } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    // Model-space vertices of the GPU transform stay resident (up to ~96 MB).
    const want = 256 << 20, limits = adapter.limits;
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: Math.min(limits.maxStorageBufferBindingSize, want),
      maxBufferSize: Math.min(limits.maxBufferSize, want) } });
    const [r3d, compose, tilegen] = await Promise.all(['r3d.wgsl', 'compose.wgsl', 'tilegen.wgsl'].map(n => fetch(shaderBase + n).then(r => r.text())));
    return new Daytona2Renderer(canvas, device, r3d, compose, gpuTilegen ? tilegen : null);
  }
  constructor(canvas, device, r3dCode, composeCode, tilegenCode = null) {
    this.canvas = canvas; this.device = device;
    this.widescreen = true; this.renderScale = 1; this.classic = false;   // classic: original 496x384 4:3 target
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    device.lost.then(info => console.error('[webgpu] device lost', info.message));
    this.textureRam = device.createTexture({ size: [2048, 2048], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // 2D layers: composed on the GPU by tilegen.wgsl (rgba8unorm storage
    // textures), or uploaded as BGRA images composed in WASM (CPU fallback).
    this.gpuTilegen = !!tilegenCode;
    const layerFormat = this.gpuTilegen ? 'rgba8unorm' : 'bgra8unorm';
    const layerUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (this.gpuTilegen ? GPUTextureUsage.STORAGE_BINDING : 0);
    this.back = device.createTexture({ size: [BACK_W, SCREEN_H], format: layerFormat, usage: layerUsage });
    this.front = device.createTexture({ size: [SCREEN_W, SCREEN_H], format: layerFormat, usage: layerUsage });
    if (this.gpuTilegen) {
      const tile = device.createShaderModule({ code: tilegenCode });
      const C = GPUShaderStage.COMPUTE;
      const tileLayout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } }] });
      const pl = device.createPipelineLayout({ bindGroupLayouts: [tileLayout] });
      this.tileExtend = device.createComputePipeline({ layout: pl, compute: { module: tile, entryPoint: 'extend_pass' } });
      this.tileCompose = device.createComputePipeline({ layout: pl, compute: { module: tile, entryPoint: 'compose_pass' } });
      this.tileMemory = device.createBuffer({ size: TILEGEN_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.tileExtension = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
      this.tileGroup = device.createBindGroup({ layout: tileLayout, entries: [
        { binding: 0, resource: { buffer: this.tileMemory } }, { binding: 1, resource: this.back.createView() },
        { binding: 2, resource: this.front.createView() }, { binding: 3, resource: { buffer: this.tileExtension } }] });
      this.tilePending = false;
    }
    this.vertexBuffer = null; this.vertexCapacity = 0; this.vertexCount = 0;
    this.drawBuffer = null; this.drawCapacity = 0;
    this.targetW = 0; this.targetH = 0;
    const r3d = device.createShaderModule({ code: r3dCode });
    const comp = device.createShaderModule({ code: composeCode });
    this.r3dLayout0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } }] });
    this.r3dLayout1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 192 } }] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.r3dLayout0, this.r3dLayout1] });
    const storage = { type: 'read-only-storage' };
    this.r3dLayout2 = device.createBindGroupLayout({ entries: [0, 1, 2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: storage })) });
    const pullLayout = device.createPipelineLayout({ bindGroupLayouts: [this.r3dLayout0, this.r3dLayout1, this.r3dLayout2] });
    this.pull = { refs: null, statics: null, instances: null, cpu: null, colours: null, group: null, generation: -1, uploaded: 0 };
    this.gpuMode = false;
    const attributes = [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'unorm8x4' },
      { shaderLocation: 4, offset: 36, format: 'uint32' }, { shaderLocation: 5, offset: 40, format: 'uint32' },
      { shaderLocation: 6, offset: 44, format: 'float32x3' }, { shaderLocation: 7, offset: 72, format: 'float32' },
      { shaderLocation: 8, offset: 76, format: 'uint32' }];
    const pipeline = (blend, depthWrite, colorWrite, pull = false) => device.createRenderPipeline({
      layout: pull ? pullLayout : layout,
      vertex: pull ? { module: r3d, entryPoint: 'vs_gpu', buffers: [] } : { module: r3d, entryPoint: 'vs', buffers: [{ arrayStride: VERTEX_BYTES, attributes }] },
      fragment: { module: r3d, entryPoint: 'fs', targets: [{ format: 'rgba16float', writeMask: colorWrite ? GPUColorWrite.ALL : 0,
        blend: blend ? { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } : undefined }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },   // facing is decided on the CPU
      depthStencil: { format: 'depth32float', depthWriteEnabled: depthWrite, depthCompare: 'greater-equal' },   // reverse Z
    });
    this.opaque = pipeline(false, true, true);
    this.transDepth = pipeline(false, true, false);
    this.translucent = pipeline(true, false, true);
    this.pullPipelines = { opaque: pipeline(false, true, true, true), depth: pipeline(false, true, false, true), trans: pipeline(true, false, true, true) };
    this.composePipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: comp, entryPoint: 'vs' },
      fragment: { module: comp, entryPoint: 'fs', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' } });
    this.nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.composeUniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.textureGroup = device.createBindGroup({ layout: this.r3dLayout0, entries: [{ binding: 0, resource: this.textureRam.createView() }] });
    this.drawData = new Float32Array(0);
    this.stats = { draws: 0, vertexUploads: 0, textureRows: 0, layerUploads: 0 };
  }
  ensureTargets(w, h) {
    if (w === this.targetW && h === this.targetH) return;
    this.targetW = w; this.targetH = h;
    this.color?.destroy(); this.depth?.destroy();
    this.color = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.composeGroup = this.device.createBindGroup({ layout: this.composePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.color.createView() }, { binding: 1, resource: this.front.createView() },
      { binding: 2, resource: this.back.createView() }, { binding: 3, resource: this.nearest },
      { binding: 4, resource: this.linear }, { binding: 5, resource: { buffer: this.composeUniform } }] });
  }
  // A storage buffer of the pull set with room for `bytes`; false if unchanged.
  ensurePull(name, bytes, spare = 1.5) {
    const b = this.pull[name], need = Math.max(256, bytes);
    if (b && b.size >= need) return false;
    b?.destroy();
    const size = Math.min(this.device.limits.maxStorageBufferBindingSize, Math.max(need * spare, 1 << 16)) + 3 & ~3;
    if (size < need) throw new Error(`[webgpu] ${name}: ${need} bytes over the device limit`);
    this.pull[name] = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.pull.group = null;
    return true;
  }
  // GPU transform: refs, instances, colours and CPU-path vertices every new
  // scene; model-space vertices only from where the GPU copy ends.
  uploadPull(heap, u32) {
    const queue = this.device.queue, P = this.pull;
    const put = (name, ptr, bytes) => { this.ensurePull(name, bytes); if (bytes) queue.writeBuffer(P[name], 0, heap.buffer, ptr, bytes); };
    put('refs', u32[31], u32[30] * REF_BYTES);
    put('instances', u32[33], u32[32] * INSTANCE_BYTES);
    put('colours', u32[35], u32[34] * 4);
    put('cpu', u32[2], u32[1] * VERTEX_BYTES);
    const count = u32[36], generation = u32[38];
    if (generation !== P.generation) { P.generation = generation; P.uploaded = 0; }
    if (this.ensurePull('statics', count * STATIC_BYTES, 2)) P.uploaded = 0;   // a new buffer starts empty
    if (count > P.uploaded) {
      queue.writeBuffer(P.statics, P.uploaded * STATIC_BYTES, heap.buffer, u32[37] + P.uploaded * STATIC_BYTES, (count - P.uploaded) * STATIC_BYTES);
      this.stats.staticVertices = count; P.uploaded = count;
    }
    if (!P.group) P.group = this.device.createBindGroup({ layout: this.r3dLayout2, entries:
      ['refs', 'statics', 'instances', 'cpu', 'colours'].map((name, binding) => ({ binding, resource: { buffer: P[name] } })) });
    this.vertexCount = u32[30];
  }
  // Upload what changed in the packet (scene, texture rows, 2D layers).
  upload(heap, packet) {
    const u32 = new Uint32Array(heap.buffer, packet, PACKET_WORDS);
    const device = this.device, queue = device.queue;
    if (u32[24] && u32[29]) {   // scene_changed, GPU transform
      this.gpuMode = true; this.uploadPull(heap, u32); this.stats.vertexUploads++;
    } else if (u32[24]) {   // scene_changed
      this.gpuMode = false;
      const count = u32[1], bytes = count * VERTEX_BYTES;
      if (bytes > this.vertexCapacity) {
        this.vertexBuffer?.destroy();
        this.vertexCapacity = Math.max(bytes * 1.5 | 0, 1 << 20);
        this.vertexBuffer = device.createBuffer({ size: this.vertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      if (bytes) queue.writeBuffer(this.vertexBuffer, 0, heap.buffer, u32[2], bytes);
      this.vertexCount = count; this.stats.vertexUploads++;
    }
    if (u32[24]) {
      if (u32[6]) {   // dirty texture rows: upload runs of consecutive rows
        const bits = new Uint32Array(heap.buffer, u32[7], 64), sheet = u32[5];
        let y = 0;
        while (y < 2048) {
          if (!(bits[y >> 5] & (1 << (y & 31)))) { y++; continue; }
          let end = y + 1;
          while (end < 2048 && (bits[end >> 5] & (1 << (end & 31)))) end++;
          queue.writeTexture({ texture: this.textureRam, origin: [0, y] }, heap.buffer,
            { offset: sheet + y * 4096, bytesPerRow: 4096 }, [2048, end - y]);
          this.stats.textureRows += end - y; y = end;
        }
      }
    }
    if (this.gpuTilegen && u32[28]) {
      // GPU tilegen: upload runs of changed 4 KB chunks of tilegen memory, then
      // clear the bitmap; render() recomposes the layers with compute.
      const bits = new Uint32Array(heap.buffer, u32[27], (TILE_CHUNKS + 31) >> 5), base = u32[26];
      let c = 0;
      while (c < TILE_CHUNKS) {
        if (!(bits[c >> 5] & (1 << (c & 31)))) { c++; continue; }
        let end = c + 1;
        while (end < TILE_CHUNKS && (bits[end >> 5] & (1 << (end & 31)))) end++;
        queue.writeBuffer(this.tileMemory, c * TILE_CHUNK, heap.buffer, base + c * TILE_CHUNK, (end - c) * TILE_CHUNK);
        this.stats.tileChunks = (this.stats.tileChunks || 0) + end - c;
        this.tilePending = true; c = end;
      }
      bits.fill(0);
    } else if (u32[10]) {   // layers_dirty
      queue.writeTexture({ texture: this.back }, heap.buffer, { offset: u32[8], bytesPerRow: BACK_W * 4 }, [BACK_W, SCREEN_H]);
      queue.writeTexture({ texture: this.front }, heap.buffer, { offset: u32[9], bytesPerRow: SCREEN_W * 4 }, [SCREEN_W, SCREEN_H]);
      this.stats.layerUploads++;
    }
    // Viewports are re-read every frame (they are small and the window may change).
    this.viewports = new Float32Array(heap.buffer, u32[4], u32[3] * VIEWPORT_FLOATS).slice();
    this.flags = { clipHud: u32[11], menuFill: u32[12], pictureFill: u32[13], backExtended: u32[14], scrollFull: u32[23] };
    const f32 = new Float32Array(heap.buffer, packet, 28);
    this.scrollFog = [f32[15], f32[16], f32[17], f32[18]]; this.scrollVp = [f32[19], f32[20], f32[21], f32[22]];
  }
  render() {
    const device = this.device, rt0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const lay = computeLayout(cw, ch, this.widescreen && !this.classic ? Math.max(4 / 3, cw / ch) : 4 / 3);
    const outW = this.classic ? SCREEN_W : Math.max(1, Math.round(lay.viewW * lay.scale * this.renderScale));
    const outH = this.classic ? SCREEN_H : Math.max(1, Math.round(SCREEN_H * lay.scale * this.renderScale));
    this.ensureTargets(outW, outH);
    const vps = this.viewports || new Float32Array(0), n = vps.length / VIEWPORT_FLOATS;
    const sx = outW / lay.viewW, sy = outH / SCREEN_H, widen = lay.viewW / SCREEN_W;
    // Build all draws first so their uniforms go up in one write.
    const draws = [];
    const firstPriority = n ? vps[0] : 0;
    for (let k = 0; k < n; k++) {
      const o = k * VIEWPORT_FLOATS;
      const v = { priority: vps[o], x: vps[o + 1], y: vps[o + 2], w: vps[o + 3], h: vps[o + 4], full: vps[o + 5] > 0.5,
        checker: vps[o + 6], framedSky: vps[o + 7] > 0.5, of: vps[o + 52], oc: vps[o + 53], tf: vps[o + 54], tc: vps[o + 55], o };
      const vx = v.full ? 0 : v.x + lay.gameX0, vw = v.full ? lay.viewW : v.w;
      const rect = [vx * sx, v.y * sy, vw * sx, v.h * sy];
      const x0 = Math.max(0, Math.floor(vx * sx)), y0 = Math.max(0, Math.floor(v.y * sy));
      const scissor = [x0, y0, Math.max(0, Math.min(outW - x0, Math.round(vw * sx))), Math.max(0, Math.min(outH - y0, Math.round(v.h * sy)))];
      const uniform = new Float32Array(48);
      uniform.set(vps.subarray(o + 8, o + 24), 0);   // proj
      if (v.full && !v.framedSky) { uniform[0] /= widen; uniform[8] /= widen; }
      uniform.set(vps.subarray(o + 24, o + 28), 16);   // sun
      uniform.set(vps.subarray(o + 28, o + 32), 20);   // fog colour
      uniform.set(vps.subarray(o + 32, o + 36), 24);   // ambient, density, start
      uniform[31] = 0; uniform[30] = v.full ? 2 * lay.gameX0 / lay.viewW : 0; uniform[29] = 1;   // quality.zw / aniso
      uniform.set(vps.subarray(o + 36, o + 52), 32);   // original light
      for (let pass = 0; pass < 2; pass++) {
        const count = pass ? v.tc : v.oc, first = pass ? v.tf : v.of;
        if (!count) continue;
        const base = uniform.slice(); base[28] = pass ? -1 : 1;
        if (pass) { const d = uniform.slice(); d[28] = -1000; draws.push({ v, pass, kind: 'depth', u: d, first, count, rect, scissor }); }
        draws.push({ v, pass, kind: pass ? 'trans' : 'opaque', u: base, first, count, rect, scissor });
        if (!pass && v.checker > 0 && v.full && widen > 1 && this.flags?.menuFill) {   // checker mesh repeat
          const period = v.checker / widen, copies = Math.min(16, Math.ceil(2 / period));
          for (let r = 1; r <= copies; r++) for (const sign of [-1, 1]) {
            const rep = base.slice(); rep[8] += sign * r * period;
            draws.push({ v, pass, kind: 'opaque', u: rep, first, count, rect, scissor });
          }
        }
      }
    }
    const need = Math.max(1, draws.length) * DRAW_STRIDE;
    if (need > this.drawCapacity) {
      this.drawBuffer?.destroy(); this.drawCapacity = Math.max(need * 2, 64 * DRAW_STRIDE);
      this.drawBuffer = device.createBuffer({ size: this.drawCapacity, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.drawGroup = device.createBindGroup({ layout: this.r3dLayout1, entries: [{ binding: 0, resource: { buffer: this.drawBuffer, size: 192 } }] });
      this.drawData = new Float32Array(this.drawCapacity / 4);
    }
    draws.forEach((d, i) => this.drawData.set(d.u, i * DRAW_STRIDE / 4));
    if (draws.length) device.queue.writeBuffer(this.drawBuffer, 0, this.drawData.buffer, 0, draws.length * DRAW_STRIDE);
    const encoder = device.createCommandEncoder();
    if (this.tilePending) {   // 2D layers on the GPU, as native GpuTileGen::dispatch
      const cp = encoder.beginComputePass();
      cp.setBindGroup(0, this.tileGroup);
      cp.setPipeline(this.tileExtend); cp.dispatchWorkgroups(4);
      cp.setPipeline(this.tileCompose); cp.dispatchWorkgroups(BACK_W / 8, SCREEN_H / 8);
      cp.end(); this.tilePending = false; this.stats.layerUploads++;
    }
    // One render pass per priority group: each starts with a cleared depth buffer.
    let i = 0, firstPass = true;
    const ready = this.gpuMode ? !!this.pull.group : !!this.vertexBuffer;
    if (!draws.length || !ready) {
      encoder.beginRenderPass({ colorAttachments: [{ view: this.color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0 } }).end();
    }
    while (i < draws.length && ready) {
      const priority = draws[i].v.priority;
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.color.createView(), loadOp: firstPass ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0 } });
      firstPass = false;
      if (this.gpuMode) pass.setBindGroup(2, this.pull.group); else pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setBindGroup(0, this.textureGroup);
      const pipes = this.gpuMode ? this.pullPipelines : { opaque: this.opaque, depth: this.transDepth, trans: this.translucent };
      // Opaque draws of the group first, then translucent (depth prepass, blend), as record_world.
      for (const wanted of [0, 1]) {
        for (let j = i; j < draws.length && draws[j].v.priority === priority; j++) {
          const d = draws[j]; if (d.pass !== wanted) continue;
          pass.setPipeline(pipes[d.kind]);
          const r = d.rect;
          const vx = Math.max(0, r[0]), vy = Math.max(0, r[1]);
          pass.setViewport(r[0] < 0 ? 0 : r[0], vy, Math.min(r[2], outW - vx), Math.min(r[3], outH - vy), 0, 1);
          if (!d.scissor[2] || !d.scissor[3]) continue;
          pass.setScissorRect(d.scissor[0], d.scissor[1], d.scissor[2], d.scissor[3]);
          pass.setBindGroup(1, this.drawGroup, [j * DRAW_STRIDE]);
          pass.draw(d.count, 1, d.first, 0);
        }
      }
      pass.end();
      while (i < draws.length && draws[i].v.priority === priority) i++;
    }
    // Compose onto the canvas.
    const f = this.flags || {}, sv = this.scrollVp || [0, 0, 0, 0];
    const fx0 = f.scrollFull ? 0 : sv[0] + lay.gameX0, fw = f.scrollFull ? lay.viewW : sv[2];
    const cu = new Float32Array([lay.viewW * lay.scale / cw, SCREEN_H * lay.scale / ch, lay.ox / cw, lay.oy / ch,
      lay.gameX0 / lay.viewW, SCREEN_W / lay.viewW, f.backExtended ? 1 : 0, f.clipHud ? 1 : 0,
      f.pictureFill || 0, 0, 0, 0, ...(this.scrollFog || [0, 0, 0, 0]),
      fx0 / lay.viewW, sv[1] / SCREEN_H, (fx0 + fw) / lay.viewW, (sv[1] + sv[3]) / SCREEN_H]);
    device.queue.writeBuffer(this.composeUniform, 0, cu);
    const rt1 = performance.now(), swap = this.context.getCurrentTexture(), rt2 = performance.now();
    const cp = encoder.beginRenderPass({ colorAttachments: [{ view: swap.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    cp.setPipeline(this.composePipeline); cp.setBindGroup(0, this.composeGroup); cp.draw(3); cp.end();
    device.queue.submit([encoder.finish()]);
    const rt3 = performance.now();
    this.timing = { build: rt1 - rt0, swap: rt2 - rt1, submit: rt3 - rt2 };
    this.stats.draws = draws.length;
  }
}
