// Real3D geometry for Daytona USA 2 (Claude 2026-11-11). WGSL port of the
// active "original hardware" path of LostWorldNative r3d.vert / r3d.frag /
// r3d_texture.glsl / original_lighting.glsl as configured for Daytona 2
// (graphics/video_device.cpp): hardware texture LOD with micro texture,
// original per-viewport lighting and spotlight, per-polygon fog, alpha rules
// of the opaque / translucent-depth / translucent passes, HUD edge shift.
// Effects that Daytona 2 leaves off (AO, bloom, haze, rain, ray tracing,
// shadows, relief, DLAA motion) are not compiled in.

struct Draw {
  proj: mat4x4<f32>,
  sun: vec4<f32>,        // xyz direction (view space), w intensity
  fog_color: vec4<f32>,  // rgb, a = fog ambient
  params: vec4<f32>,     // ambient, fog density, fog start, unused
  quality: vec4<f32>,    // x: pass (1 opaque, -1 translucent, -1000 translucent depth), z: HUD shift
  light_shape: vec4<f32>, light_color: vec4<f32>, light_fog: vec4<f32>, light_controls: vec4<f32>,
};
@group(0) @binding(0) var texture_ram: texture_2d<u32>;   // 2048x2048 r16uint (as r32uint)
@group(1) @binding(0) var<uniform> vp: Draw;

const TEXTURED = 1u; const ALPHA_TEST = 2u; const MIRROR_U = 4u; const MIRROR_V = 8u;
const SMOOTH_U = 16u; const SMOOTH_V = 32u; const LUMINOUS = 64u; const FIXED_SHADE = 128u;
const SPECULAR = 256u; const TEX_ALPHA = 512u; const INVERT_RGB = 4096u; const TRANSLATOR = 8192u;
const STEP15_LUMINOUS = 524288u; const HARDWARE_LOD = 1048576u; const HARDWARE_LIGHTING = 2097152u; const SMOOTH_SHADE = 4194304u;

struct VIn {
  @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>, @location(4) tex: u32, @location(5) flags: u32,
  @location(6) params: vec3<f32>, @location(7) lod_base: f32, @location(8) micro: u32,
};
struct VOut {
  @builtin(position) position: vec4<f32>,
  @location(0) view_pos: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>, @location(4) @interpolate(flat) tex: u32, @location(5) @interpolate(flat) flags: u32,
  @location(6) params: vec3<f32>, @location(7) lod_base: f32, @location(8) @interpolate(flat) micro: u32, @location(9) clip_w: f32,
};

// GPU vertex transform (Claude 2026-11-12; r3d_scene.h R3DGpuVertex): the
// vertex is pulled through a ref, either a model-space vertex decoded once
// from VROM plus the instance it is drawn with, or a vertex the CPU already
// transformed (models in polygon RAM). vs_gpu does for the first what
// R3DSceneBuilder::model() does on the CPU (and R3DSceneBuilder::expand
// mirrors): transform, back-face test, alpha, texture word, texture LOD base.
@group(2) @binding(0) var<storage, read> refs: array<vec2<u32>>;
@group(2) @binding(1) var<storage, read> statics: array<u32>;     // R3DGpuVertex: 24 words
@group(2) @binding(2) var<storage, read> instances: array<u32>;   // R3DGpuInstance: 20 words
@group(2) @binding(3) var<storage, read> cpu_vertices: array<u32>; // R3DVertex: 20 words
@group(2) @binding(4) var<storage, read> colours: array<u32>;
const REF_CPU = 0xFFFFFFFFu; const GPU_DOUBLE_SIDED = 1u; const GPU_TABLE = 2u;

fn sf(i: u32) -> f32 { return bitcast<f32>(statics[i]); }
fn s3(i: u32) -> vec3<f32> { return vec3<f32>(sf(i), sf(i + 1u), sf(i + 2u)); }
fn if32(i: u32) -> f32 { return bitcast<f32>(instances[i]); }
fn cf(i: u32) -> f32 { return bitcast<f32>(cpu_vertices[i]); }

@vertex fn vs_gpu(@builtin(vertex_index) index: u32) -> VOut {
  let r = refs[index];
  var v: VIn;
  if (r.y == REF_CPU) {
    let b = r.x * 20u;
    v.pos = vec3<f32>(cf(b), cf(b + 1u), cf(b + 2u)); v.nrm = vec3<f32>(cf(b + 3u), cf(b + 4u), cf(b + 5u));
    v.uv = vec2<f32>(cf(b + 6u), cf(b + 7u)); v.color = unpack4x8unorm(cpu_vertices[b + 8u]);
    v.tex = cpu_vertices[b + 9u]; v.flags = cpu_vertices[b + 10u];
    v.params = vec3<f32>(cf(b + 11u), cf(b + 12u), cf(b + 13u)); v.lod_base = cf(b + 18u); v.micro = cpu_vertices[b + 19u];
    return emit(v);
  }
  let b = r.x * 24u; let ib = r.y * 20u;
  let c0 = vec3<f32>(if32(ib), if32(ib + 1u), if32(ib + 2u));
  let c1 = vec3<f32>(if32(ib + 3u), if32(ib + 4u), if32(ib + 5u));
  let c2 = vec3<f32>(if32(ib + 6u), if32(ib + 7u), if32(ib + 8u));
  let tr = vec3<f32>(if32(ib + 9u), if32(ib + 10u), if32(ib + 11u));
  let inv_scale = if32(ib + 12u); let inst_alpha = if32(ib + 13u); let lod_k = if32(ib + 14u);
  let inst_tex = instances[ib + 15u]; let color_base = instances[ib + 16u];
  let kind = statics[b + 23u];
  let alpha = min(1.0, sf(b + 15u) * inst_alpha);
  let face = s3(b + 6u); let v0 = s3(b + 9u);
  let fn_ = c0 * face.x + c1 * face.y + c2 * face.z;
  let p0 = c0 * v0.x + c1 * v0.y + c2 * v0.z + tr;
  let facing = dot(p0, fn_);
  let back = !(facing <= 0.0);
  if (!(alpha > 0.0) || (back && (kind & GPU_DOUBLE_SIDED) == 0u)) {
    var o: VOut;   // dropped: every corner of the polygon lands on one point, nothing is drawn
    o.position = vec4<f32>(0.0, 0.0, 0.0, 1.0); o.clip_w = 1.0;
    return o;
  }
  let pm = s3(b); let nm = s3(b + 3u);
  v.pos = c0 * pm.x + c1 * pm.y + c2 * pm.z + tr;
  v.nrm = (c0 * nm.x + c1 * nm.y + c2 * nm.z) * inv_scale;
  v.uv = vec2<f32>(sf(b + 12u), sf(b + 13u));
  var rgb = statics[b + 14u];
  if ((kind & GPU_TABLE) != 0u) { rgb = colours[color_base + rgb]; }
  v.color = vec4<f32>(unpack4x8unorm(rgb).xyz, floor(alpha * 255.0 + 0.5) / 255.0);
  let st = statics[b + 16u];
  let tx = ((st & 2047u) + (inst_tex & 2047u)) & 2047u;
  let ty = (((st >> 11u) & 1023u) + ((inst_tex >> 11u) & 1023u)) & 1023u;
  let page = ((st >> 21u) ^ (inst_tex >> 21u)) & 1u;
  v.tex = tx | ((ty + 1024u * page) << 11u) | (st & 0xFFC00000u);
  v.flags = statics[b + 17u];
  v.params = vec3<f32>(sf(b + 18u), sf(b + 19u), sf(b + 20u));
  v.lod_base = dot(v.pos, fn_) * (lod_k * sf(b + 21u));
  v.micro = statics[b + 22u];
  if (back) { v.nrm = -v.nrm; v.lod_base = -v.lod_base; }   // double-sided, seen from behind
  return emit(v);
}

@vertex fn vs(v: VIn) -> VOut { return emit(v); }

fn emit(v: VIn) -> VOut {
  var o: VOut;
  o.view_pos = v.pos; o.normal = v.nrm; o.uv = v.uv; o.color = v.color; o.tex = v.tex; o.flags = v.flags;
  o.params = v.params; o.lod_base = v.lod_base; o.micro = v.micro;
  var p = vp.proj * vec4<f32>(v.pos, 1.0);
  var shift = 0.0;
  if ((v.flags & 0x4000u) != 0u) { shift = -vp.quality.z; } else if ((v.flags & 0x8000u) != 0u) { shift = vp.quality.z; }
  p.x += shift * p.w;
  p.y = -p.y;   // Vulkan clip space has +y down, WebGPU +y up (viewport origin is top-left in both)
  o.position = p; o.clip_w = p.w;
  return o;
}

fn decode(t: u32, fmt: u32) -> vec4<f32> {
  switch (fmt) {
    case 0u: { return vec4<f32>(f32((t >> 10u) & 31u), f32((t >> 5u) & 31u), f32(t & 31u), 0.0) / 31.0
                 + vec4<f32>(0.0, 0.0, 0.0, select(1.0, 0.0, (t & 0x8000u) != 0u)); }
    case 1u: { return vec4<f32>(vec3<f32>(f32(t & 15u)), f32((t >> 4u) & 15u)) / 15.0; }
    case 2u: { return vec4<f32>(vec3<f32>(f32((t >> 4u) & 15u)), f32(t & 15u)) / 15.0; }
    case 3u: { return vec4<f32>(vec3<f32>(f32((t >> 8u) & 15u)), f32((t >> 12u) & 15u)) / 15.0; }
    case 4u: { return vec4<f32>(vec3<f32>(f32((t >> 12u) & 15u)), f32((t >> 8u) & 15u)) / 15.0; }
    case 5u: { let l = t & 255u; return vec4<f32>(vec3<f32>(f32(l) / 255.0), select(1.0, 0.0, l == 255u)); }
    case 6u: { let l = (t >> 8u) & 255u; return vec4<f32>(vec3<f32>(f32(l) / 255.0), select(1.0, 0.0, l == 255u)); }
    case 7u: { return vec4<f32>(f32((t >> 12u) & 15u), f32((t >> 8u) & 15u), f32((t >> 4u) & 15u), f32(t & 15u)) / 15.0; }
    default: { let n = (t >> (4u * (fmt - 8u))) & 15u; return vec4<f32>(vec3<f32>(f32(n) / 15.0), select(1.0, 0.0, n == 15u)); }
  }
}
fn wrap(c: i32, size: i32, mirror: bool) -> i32 {
  let period = select(size, size * 2, mirror);
  let m = ((c % period) + period) % period;
  return select(m, period - 1 - m, mirror && m >= size);
}
fn fetch(base: vec2<i32>, size: vec2<i32>, c0: vec2<i32>, fmt: u32, addressing: u32, flags: u32) -> vec4<f32> {
  let cx = wrap(c0.x, size.x, (addressing & MIRROR_U) != 0u);
  let cy = wrap(c0.y, size.y, (addressing & MIRROR_V) != 0u);
  let p = vec2<i32>((base.x + cx) & 2047, (base.y & 1024) | ((base.y + cy) & 1023));
  var t = decode(textureLoad(texture_ram, p, 0).r, fmt);
  if ((flags & (TEX_ALPHA | ALPHA_TEST)) == 0u) { t.a = 1.0; }
  return t;
}
const MIP_X_INIT = array<i32, 12>(0, 1024, 1536, 1792, 1920, 1984, 2016, 2032, 2040, 2044, 2046, 2047);
const MIP_Y_INIT = array<i32, 11>(0, 512, 768, 896, 960, 992, 1008, 1016, 1020, 1022, 1023);

fn bilinear_addressed(base: vec2<i32>, size: vec2<i32>, st: vec2<f32>, level: i32, fmt: u32, addressing: u32, flags: u32) -> vec4<f32> {
  var mip_x = MIP_X_INIT; var mip_y = MIP_Y_INIT;
  let b = vec2<i32>(mip_x[level] + (base.x >> u32(level)), (base.y & 1024) | (mip_y[level] + ((base.y & 1023) >> u32(level))));
  let s = max(size >> vec2<u32>(u32(level)), vec2<i32>(1));
  let p = st / f32(1 << u32(level)) - 0.5;
  var i0 = vec2<i32>(floor(p));
  let f = p - vec2<f32>(i0);
  var i1 = i0 + 1;
  var smooth_u = (addressing & SMOOTH_U) != 0u; var smooth_v = (addressing & SMOOTH_V) != 0u;
  if ((addressing & ALPHA_TEST) != 0u) { smooth_u = false; smooth_v = false; }
  let first = vec2<i32>(floor((p + 0.5) / vec2<f32>(s))) * s;
  if (!smooth_u) { i0.x = clamp(i0.x, first.x, first.x + s.x - 1); i1.x = clamp(i1.x, first.x, first.x + s.x - 1); }
  if (!smooth_v) { i0.y = clamp(i0.y, first.y, first.y + s.y - 1); i1.y = clamp(i1.y, first.y, first.y + s.y - 1); }
  var a = fetch(b, s, i0, fmt, addressing, flags);
  var bb = fetch(b, s, vec2<i32>(i1.x, i0.y), fmt, addressing, flags);
  var c = fetch(b, s, vec2<i32>(i0.x, i1.y), fmt, addressing, flags);
  var d = fetch(b, s, i1, fmt, addressing, flags);
  if ((flags & ALPHA_TEST) != 0u) {
    var taps = array<vec4<f32>, 4>(a, bb, c, d);
    var src = array<i32, 8>(0, 0, 1, 1, 2, 2, 3, 3);
    var dst = array<i32, 8>(1, 2, 0, 3, 0, 3, 2, 1);
    for (var e = 0; e < 8; e++) {
      if (taps[src[e]].a > taps[dst[e]].a) { taps[dst[e]] = vec4<f32>(taps[src[e]].rgb, taps[dst[e]].a); }
    }
    return mix(mix(taps[0], taps[1], f.x), mix(taps[2], taps[3], f.x), f.y);
  }
  if ((flags & HARDWARE_LOD) != 0u) { return mix(mix(a, bb, f.x), mix(c, d, f.x), f.y); }
  a = vec4<f32>(a.rgb * a.a, a.a); bb = vec4<f32>(bb.rgb * bb.a, bb.a);
  c = vec4<f32>(c.rgb * c.a, c.a); d = vec4<f32>(d.rgb * d.a, d.a);
  return mix(mix(a, bb, f.x), mix(c, d, f.x), f.y);
}
fn find_msb(v: i32) -> i32 { return 31 - i32(countLeadingZeros(u32(v))); }

fn hardware_texture(base: vec2<i32>, size: vec2<i32>, st: vec2<f32>, fmt: u32, flags: u32, lod_base: f32, w: f32, micro: u32) -> vec4<f32> {
  let last_level = max(find_msb(min(size.x, size.y)) - 1, 0);
  let footprint = lod_base * w * w;
  let raw_lod = select(f32(last_level), -log2(footprint), footprint > 0.0);
  let lod = clamp(raw_lod, 0.0, f32(last_level));
  let lower = i32(floor(lod)); let upper = min(lower + 1, last_level);
  var result = bilinear_addressed(base, size, st, lower, fmt, flags, flags);
  let fraction = fract(lod);
  if (fraction > 0.0) {
    result = mix(result, bilinear_addressed(base, size, st, upper, fmt, flags, flags), fraction);
  } else if (raw_lod < 0.0 && (micro & 16u) != 0u) {
    let id = (micro >> 5u) & 7u; let minimum = (micro >> 2u) & 3u;
    var micro_base = vec2<i32>(select(0, 128, (id & 2u) != 0u), i32(id & 1u) * 128 + select(0, 256, (id & 4u) != 0u));
    micro_base.y += (base.y & 1024) ^ 1024;
    var repeats = array<f32, 4>(2.0, 4.0, 16.0, 256.0);
    let detail = bilinear_addressed(micro_base, vec2<i32>(128), st * repeats[minimum], 0, fmt, SMOOTH_U | SMOOTH_V, flags);
    let weight = min(-raw_lod * exp2(-f32(minimum)) * 0.5, 0.5);
    result = mix(result, detail, weight);
  }
  return result;
}
fn sample_texture(uv: vec2<f32>, tex: u32, flags: u32, lod_base: f32, w: f32, micro: u32) -> vec4<f32> {
  let base = vec2<i32>(i32(tex & 2047u), i32((tex >> 11u) & 2047u));
  let size = vec2<i32>(32 << ((tex >> 22u) & 7u), 32 << ((tex >> 25u) & 7u));
  let fmt = (tex >> 28u) & 15u;
  let st = uv * vec2<f32>(size);
  if ((flags & HARDWARE_LOD) != 0u) { return hardware_texture(base, size, st, fmt, flags, lod_base, w, micro); }
  var sum = bilinear_addressed(base, size, st, 0, fmt, flags, flags);   // original look: base level only
  if ((flags & ALPHA_TEST) == 0u) { sum = vec4<f32>(select(vec3<f32>(0.0), sum.rgb / sum.a, sum.a > 0.0), sum.a); }
  return sum;
}
fn original_spotlight(point: vec3<f32>) -> vec2<f32> {
  if (vp.light_shape.z <= 0.0 || vp.light_shape.w <= 0.0) { return vec2<f32>(0.0); }
  let distance = -point.z;
  if (distance < vp.light_color.w) { return vec2<f32>(0.0); }
  let ellipse = (point.xy / distance - vp.light_shape.xy) * vp.light_shape.zw;
  let lobe = max(1.0 - dot(ellipse, ellipse), 0.0);
  let extent = abs(vp.light_fog.w);
  var range = 0.0;
  if (extent > 0.0) {
    let past = max(distance - vp.light_color.w - extent, 0.0);
    let attenuation = 1.0 / (1.0 + past / (1.0 + extent));
    range = attenuation * attenuation;
  }
  return vec2<f32>(lobe * range, lobe);
}
fn original_surface_light(value0: vec4<f32>, n: vec3<f32>, shade: f32, spot: f32, flags: u32, spec: f32, color_a: f32) -> vec4<f32> {
  var value = value0;
  var diffuse = clamp(select(dot(vp.sun.xyz, n), shade, (flags & FIXED_SHADE) != 0u), -1.0, 1.0);
  if (vp.light_controls.x > 0.5 || value.a < 0.999) { diffuse = max(diffuse, 0.0); }
  value = vec4<f32>(value.rgb * (vec3<f32>(diffuse * vp.sun.w + vp.params.x) + vp.light_color.rgb * spot), value.a);
  if ((flags & SPECULAR) != 0u) {
    var specular: f32;
    if ((flags & SMOOTH_SHADE) != 0u) {
      var exponent = array<f32, 4>(8.0, 16.0, 32.0, 64.0);
      var gain = array<f32, 4>(1.6, 1.6, 2.4, 3.2);
      let index = (flags >> 10u) & 3u;
      specular = pow(max(diffuse, 0.0), exponent[index]) * gain[index];
    } else { specular = max(reflect(-vp.sun.xyz, n).z, 0.0); }
    specular *= spec * vp.sun.w;
    value = vec4<f32>(value.rgb + vec3<f32>(specular), value.a);
    if (color_a < 1.0) { value.a = max(value.a, specular); }
  }
  return value;
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let flags = i.flags;
  var col = i.color;
  if ((flags & TRANSLATOR) != 0u) { col = vec4<f32>(col.rgb * 16.0, col.a); }
  if (vp.fog_color.w < 0.0 && dot(i.view_pos, vp.sun.xyz) + vp.fog_color.x > vp.fog_color.y) { discard; }
  var t = vec4<f32>(1.0);
  if ((flags & TEXTURED) != 0u) {
    t = sample_texture(i.uv, i.tex, flags, i.lod_base, 1.0 / i.clip_w, i.micro);   // gl_FragCoord.w
    if ((flags & INVERT_RGB) != 0u) { t = vec4<f32>(1.0 - t.rgb, t.a); }
    if ((flags & (TEX_ALPHA | ALPHA_TEST)) == 0u) { t.a = 1.0; }
    if ((flags & ALPHA_TEST) != 0u && t.a < 32.0 / 255.0) { discard; }
  }
  let ambient = vp.params.x; let fixed_shade = i.params.x;
  if ((flags & (LUMINOUS | STEP15_LUMINOUS)) == (LUMINOUS | STEP15_LUMINOUS)) {
    col = vec4<f32>(col.rgb * select(1.5, 1.0 + fixed_shade + ambient, (flags & FIXED_SHADE) != 0u), col.a);
  }
  var c = t * col;
  if (c.a < 1.0 / 32.0) { discard; }
  if (vp.quality.x <= -1000.0) {   // translucent depth prepass
    if ((flags & (TEX_ALPHA | ALPHA_TEST | LUMINOUS)) != 0u) { discard; }
    return c;
  }
  if ((flags & TEX_ALPHA) != 0u && select((c.a >= 1.0), (c.a < 1.0), (vp.quality.x > 0.0))) { discard; }
  var native_spot = vec2<f32>(0.0);
  if ((flags & HARDWARE_LIGHTING) != 0u) { native_spot = original_spotlight(i.view_pos); }
  if ((flags & LUMINOUS) == 0u) {
    if ((flags & HARDWARE_LIGHTING) != 0u) {
      c = original_surface_light(c, i.normal, fixed_shade, native_spot.x, flags, i.params.z, i.color.a);
    } else {
      var s = clamp(select(dot(vp.sun.xyz, i.normal), fixed_shade, (flags & FIXED_SHADE) != 0u), -1.0, 1.0);
      s = max(s, 0.0);
      c = vec4<f32>(c.rgb * vec3<f32>(s * vp.sun.w + ambient), c.a);
      if ((flags & SPECULAR) != 0u) {
        var powers = array<f32, 4>(8.0, 16.0, 32.0, 64.0); var scales = array<f32, 4>(1.6, 1.6, 2.4, 3.2);
        let shin = (flags >> 10u) & 3u;
        c = vec4<f32>(c.rgb + pow(max(s, 0.0), powers[shin]) * scales[shin] * i.params.z * vp.sun.w, c.a);
      }
    }
  }
  c = vec4<f32>(min(c.rgb, vec3<f32>(1.0)), c.a);
  let fog = i.params.y * clamp(vp.params.z + (-i.view_pos.z) * vp.params.y, 0.0, 1.0);
  var fog_color = vp.fog_color.rgb * vp.fog_color.a;
  if ((flags & HARDWARE_LIGHTING) != 0u) { fog_color += vp.light_fog.rgb * native_spot.y; }
  c = vec4<f32>(mix(c.rgb, fog_color, fog), c.a);
  if (vp.quality.x > 0.0) { c.a = 1.0; }
  return c;
}
