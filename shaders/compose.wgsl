// Final composition for Daytona USA 2 (Claude 2026-11-11). WGSL port of the
// active path of LostWorldNative compose.frag as configured for Daytona 2:
// back layers (extended 200 px beyond each side of the 4:3 area), 3D image,
// original scroll fog over the back layers, front (HUD) layers clipped to the
// 4:3 area during races and selection menus, gap fill of picture backdrops,
// widescreen layout and black bars. Plain 2D pixels (no xBR), saturation and
// gamma 1, no crosshairs, overlays, sky packs, bloom or HDR (all off in D2).
struct Compose {
  scale: vec2<f32>, offset: vec2<f32>,   // 3D view rectangle in the window (fractions)
  layer2d: vec2<f32>,                    // x offset and width of the 4:3 area inside the view
  flags: vec2<f32>,                      // x: back layers extended, y: clip HUD
  fill: vec4<f32>,                       // x: picture background fill (0, 1, 2)
  scroll_fog: vec4<f32>,                 // rgb, amount
  scroll_rect: vec4<f32>,                // x0, y0, x1, y1 in view fractions
};
@group(0) @binding(0) var scene3d: texture_2d<f32>;
@group(0) @binding(1) var front_tex: texture_2d<f32>;
@group(0) @binding(2) var back_tex: texture_2d<f32>;
@group(0) @binding(3) var nearest: sampler;
@group(0) @binding(4) var linear3d: sampler;
@group(0) @binding(5) var<uniform> pc: Compose;

struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut; o.uv = uv; o.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  return o;
}
const SIZE_X = 496.0; const BACK_MARGIN = 200.0; const BACK_X = 896.0;

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let p = (i.uv - pc.offset) / pc.scale;
  var c = vec3<f32>(0.0);
  // Sample unconditionally (uniform control flow for implicit derivatives).
  let s = textureSampleLevel(scene3d, linear3d, clamp(p, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
  var q = vec2<f32>((p.x - pc.layer2d.x) / pc.layer2d.y, p.y);
  let edge = vec2<f32>((q.x * SIZE_X + BACK_MARGIN) / BACK_X, q.y);
  let qb = vec2<f32>(clamp(edge.x, 0.5 / BACK_X, 1.0 - 0.5 / BACK_X), q.y);
  q.x = clamp(q.x, 0.5 / SIZE_X, 1.0 - 0.5 / SIZE_X);
  let inside_43 = p.x >= pc.layer2d.x && p.x <= pc.layer2d.x + pc.layer2d.y;
  let back_s = textureSampleLevel(back_tex, nearest, qb, 0.0);
  let fill_s = textureSampleLevel(back_tex, nearest, edge, 0.0);   // clamp to edge: the nearest column
  let front_s = textureSampleLevel(front_tex, nearest, q, 0.0);
  if (p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0) {
    var back = vec4<f32>(0.0);
    if (pc.flags.x > 0.5 || inside_43 || pc.fill.x > 0.5) {
      back = back_s;
      if (pc.fill.x > 0.5 && !inside_43) { back += fill_s * (1.0 - back.a); }
    }
    var front = vec4<f32>(0.0);
    if (pc.flags.y < 0.5 || inside_43) { front = front_s; }
    let in_fog = all(p >= pc.scroll_rect.xy) && all(p < pc.scroll_rect.zw);
    if (in_fog && pc.scroll_fog.a > 0.0) { back = vec4<f32>(mix(back.rgb, pc.scroll_fog.rgb, pc.scroll_fog.a), back.a); }
    c = back.rgb * (1.0 - s.a) + s.rgb;
    c = c * (1.0 - front.a) + front.rgb;
  }
  return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
