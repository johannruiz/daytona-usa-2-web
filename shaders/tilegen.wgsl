// Daytona USA 2 tilegen on the GPU (Claude 2026-11-11): WGSL port of the
// native compute path graphics/shaders/gpu_tilegen_common.glsl,
// gpu_tilegen_extend.comp and gpu_tilegen.comp (formats after LostWorldNative's
// MIT TileGen reference). Input: raw tilegen memory as little-endian words,
// uploaded by changed 4 KB chunks. Output: the back layer (896x384, 200-pixel
// margins for widescreen) and the front layer (496x384), straight into the
// textures the compose pass samples.

@group(0) @binding(0) var<storage, read> words: array<u32>;
@group(0) @binding(1) var back_image: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var front_image: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> extend_layer: array<u32, 4>;

const LINE_SCROLL = 0xf6000u;
const MASK_BASE = 0xf7000u;
const NAMES = 0xf8000u;
const PALETTE = 0x100000u;
const REGS = 0x180000u;

fn read_word(address: u32) -> u32 { return words[address >> 2u]; }
fn format_word() -> u32 { return read_word(REGS + 0x20u); }
fn scroll_word(layer: u32) -> u32 { return read_word(REGS + 0x60u + 4u * layer); }

fn pixel(layer: u32, x: i32, y: i32) -> vec4<u32> {
  let scroll = scroll_word(layer);
  var xs = i32(scroll & 1023u);
  let ys = i32((scroll >> 16u) & 511u);
  if ((scroll & 0x8000u) != 0u) {
    let w = read_word(LINE_SCROLL + 0x400u * layer + u32(y / 2) * 4u);
    xs = i32(select(w >> 16u, w & 65535u, (y & 1) != 0) & 1023u);
  }
  let px = u32(x + xs) & 511u;
  let py = u32(y + ys) & 511u;
  let tx = px / 8u;
  let fy = py & 7u;
  let fx = px & 7u;
  let pair = read_word(NAMES + 0x2000u * layer + (py / 8u) * 128u + (tx / 2u) * 4u);
  let e = select(pair >> 16u, pair & 65535u, (tx & 1u) != 0u);
  var index: u32;
  if ((format_word() & (1u << (12u + layer))) != 0u) {
    let pattern = ((e & 0x3fffu) << 1u) | (e >> 15u);
    let bits = read_word((pattern * 32u + fy * 4u) % LINE_SCROLL);
    index = (e & 0x7ff0u) | ((bits >> ((7u - fx) * 4u)) & 15u);
  } else {
    let pattern = e & 0x3fffu;
    let bits = read_word((pattern * 64u + fy * 8u + select(0u, 4u, (fx & 4u) != 0u)) % LINE_SCROLL);
    index = (e & 0x7f00u) | ((bits >> ((3u - (fx & 3u)) * 8u)) & 255u);
  }
  let c = read_word(PALETTE + 4u * index);
  if ((c & 0x8000u) != 0u) { return vec4<u32>(0u); }
  let offset = read_word(REGS + 0x40u + 4u * (layer / 2u));
  var rgb = vec3<i32>(i32(c & 31u), i32((c >> 5u) & 31u), i32((c >> 10u) & 31u)) * 255 / 31;
  for (var i = 0u; i < 3u; i++) {
    var o = i32((offset >> (8u * i)) & 255u);
    if (o >= 128) { o -= 256; }
    rgb[i] = clamp(rgb[i] + 2 * o, 0, 255);
  }
  return vec4<u32>(vec3<u32>(rgb), 255u);
}

// A background is extended beyond the screen only when it is a wrapping
// panorama: framed pictures leave the 16 off-screen columns black.
var<workgroup> dark_count: atomic<u32>;
@compute @workgroup_size(64)
fn extend_pass(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let layer = group.x;
  let lane = local.x;
  if (lane == 0u) { atomicStore(&dark_count, 0u); }
  workgroupBarrier();
  let format = format_word();
  let enabled = (scroll_word(layer) & 0x80000000u) != 0u && (format & (1u << (8u + layer))) == 0u;
  var dark = 0u;
  if (enabled) {
    for (var i = lane; i < 3072u; i += 64u) {
      let c = pixel(layer, 496 + i32(i % 16u), i32(i / 16u) * 2);
      if (c.r < 24u && c.g < 24u && c.b < 24u) { dark++; }
    }
  }
  atomicAdd(&dark_count, dark);
  workgroupBarrier();
  if (lane == 0u) {
    extend_layer[layer] = select(0u, 1u, enabled && atomicLoad(&dark_count) * 10u < 3072u * 9u);
  }
}

@compute @workgroup_size(8, 8)
fn compose_pass(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= 896u || id.y >= 384u) { return; }
  let x = i32(id.x) - 200;
  let y = i32(id.y);
  let on_screen = x >= 0 && x < 496;
  let mask = read_word(MASK_BASE + u32(y) * 4u);
  let format = format_word();
  let column = u32(clamp(x, 0, 495) / 32);
  var back = vec4<u32>(0u);
  var front = vec4<u32>(0u);
  for (var pair = 1; pair >= 0; pair--) {
    let selection = select(mask & 65535u, mask >> 16u, pair == 0);
    let layer = u32(pair) * 2u + select(1u, 0u, ((selection >> (15u - column)) & 1u) != 0u);
    if ((scroll_word(layer) & 0x80000000u) == 0u) { continue; }
    let above = (format & (1u << (8u + layer))) != 0u;
    if (!on_screen && (above || extend_layer[layer] == 0u)) { continue; }
    let c = pixel(layer, x, y);
    if (c.a == 0u) { continue; }
    if (above) { front = c; } else { back = c; }
  }
  textureStore(back_image, vec2<i32>(id.xy), vec4<f32>(back) / 255.0);
  if (on_screen) { textureStore(front_image, vec2<i32>(x, y), vec4<f32>(front) / 255.0); }
}
