import type { AdjustmentKind } from '../state/types'

// ---------------------------------------------------------------------------
// All adjustments operate on gamma-encoded (sRGB) values, exactly like
// Photoshop's Image > Adjustments do. The only exception is Exposure, which
// linearises internally because that is what Photoshop does too.
// ---------------------------------------------------------------------------

export const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const COMMON = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform float u_opacity;
uniform int u_blend;
uniform sampler2D u_mask;   // resolved mask for this layer, red channel
uniform bool u_useMask;

const float EPS = 1e-6;

// Rec.601 luma — Photoshop's weighting for luminosity-preserving operations.
float lumaPS(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < EPS) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / max(2.0 - mx - mn, EPS) : d / max(mx + mn, EPS);
  float h;
  if (mx == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else                h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5)       return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y < EPS) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hue2rgb(p, q, hsl.x + 1.0 / 3.0),
    hue2rgb(p, q, hsl.x),
    hue2rgb(p, q, hsl.x - 1.0 / 3.0)
  );
}

/** Photoshop-style signed scaling: positive pushes toward 1, negative toward 0. */
float pushToward(float v, float amount) {
  return amount >= 0.0 ? v + (1.0 - v) * amount : v * (1.0 + amount);
}

// --- non-separable blend helpers (W3C compositing spec) --------------------
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, EPS);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, EPS);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float satOf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

float softLightCh(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b)
                  : b + (2.0 * s - 1.0) * (d - b);
}

vec3 applyBlend(vec3 b, vec3 s) {
  if (u_blend == 0) return s;
  if (u_blend == 1) return b * s;
  if (u_blend == 2) return b + s - b * s;
  if (u_blend == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (u_blend == 4) return vec3(softLightCh(b.r, s.r), softLightCh(b.g, s.g), softLightCh(b.b, s.b));
  if (u_blend == 5) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (u_blend == 6) return clamp(b / max(1.0 - s, EPS), 0.0, 1.0);
  if (u_blend == 7) return 1.0 - clamp((1.0 - b) / max(s, EPS), 0.0, 1.0);
  if (u_blend == 8) return min(b, s);
  if (u_blend == 9) return max(b, s);
  if (u_blend == 10) return abs(b - s);
  if (u_blend == 11) return b + s - 2.0 * b * s;
  if (u_blend == 12) return setLum(setSat(s, satOf(b)), lum(b));
  if (u_blend == 13) return setLum(setSat(b, satOf(s)), lum(b));
  if (u_blend == 14) return setLum(s, lum(b));
  if (u_blend == 15) return setLum(b, lum(s));
  return s;
}

vec3 adjust(vec3 c);

void main() {
  vec4 src = texture(u_src, v_uv);
  float m = u_useMask ? texture(u_mask, v_uv).r : 1.0;
  if (m <= 0.0) { fragColor = src; return; }
  vec3 res = clamp(adjust(clamp(src.rgb, 0.0, 1.0)), 0.0, 1.0);
  res = clamp(applyBlend(clamp(src.rgb, 0.0, 1.0), res), 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, res, u_opacity * m), src.a);
}
`

// ---------------------------------------------------------------------------
// Per-adjustment fragment bodies
// ---------------------------------------------------------------------------

const BRIGHTNESS_CONTRAST = `
uniform float u_brightness;  // -1..1
uniform float u_contrast;    // -1..1
uniform bool  u_legacy;

vec3 adjust(vec3 c) {
  if (u_legacy) {
    vec3 o = c + u_brightness;
    float k = u_contrast >= 0.0 ? 1.0 + u_contrast * 2.0 : 1.0 + u_contrast;
    return (o - 0.5) * k + 0.5;
  }
  // Highlight/shadow preserving brightness: white stays white, black stays black.
  vec3 o = u_brightness >= 0.0 ? c + (1.0 - c) * u_brightness : c * (1.0 + u_brightness);
  if (u_contrast >= 0.0) {
    vec3 s = o * o * (3.0 - 2.0 * o);           // smoothstep S-curve
    o = mix(o, s, u_contrast);
  } else {
    o = mix(o, o * 0.5 + 0.25, -u_contrast);    // collapse toward mid grey
  }
  return o;
}`

const LEVELS = `
uniform vec3 u_inBlack, u_inWhite, u_gamma, u_outBlack, u_outWhite;   // per R/G/B
uniform float u_mInBlack, u_mInWhite, u_mGamma, u_mOutBlack, u_mOutWhite;

float levelOne(float x, float ib, float iw, float g, float ob, float ow) {
  x = clamp((x - ib) / max(iw - ib, 1e-4), 0.0, 1.0);
  x = pow(x, 1.0 / max(g, 0.01));
  return ob + x * (ow - ob);
}

vec3 adjust(vec3 c) {
  c = vec3(
    levelOne(c.r, u_inBlack.r, u_inWhite.r, u_gamma.r, u_outBlack.r, u_outWhite.r),
    levelOne(c.g, u_inBlack.g, u_inWhite.g, u_gamma.g, u_outBlack.g, u_outWhite.g),
    levelOne(c.b, u_inBlack.b, u_inWhite.b, u_gamma.b, u_outBlack.b, u_outWhite.b)
  );
  return vec3(
    levelOne(c.r, u_mInBlack, u_mInWhite, u_mGamma, u_mOutBlack, u_mOutWhite),
    levelOne(c.g, u_mInBlack, u_mInWhite, u_mGamma, u_mOutBlack, u_mOutWhite),
    levelOne(c.b, u_mInBlack, u_mInWhite, u_mGamma, u_mOutBlack, u_mOutWhite)
  );
}`

const CURVES = `
uniform sampler2D u_lut;   // 256x1 RGBA, master(channel(x)) already baked in

float lut(float x, int ch) {
  vec4 s = texture(u_lut, vec2(clamp(x, 0.0, 1.0) * (255.0 / 256.0) + (0.5 / 256.0), 0.5));
  return ch == 0 ? s.r : ch == 1 ? s.g : s.b;
}

vec3 adjust(vec3 c) {
  return vec3(lut(c.r, 0), lut(c.g, 1), lut(c.b, 2));
}`

const EXPOSURE = `
uniform float u_exposure;  // stops
uniform float u_offset;
uniform float u_gammaC;

vec3 adjust(vec3 c) {
  vec3 lin = pow(max(c, 0.0), vec3(2.2)) * exp2(u_exposure);
  vec3 o = pow(max(lin, 0.0), vec3(1.0 / 2.2)) + u_offset;
  return pow(max(o, 0.0), vec3(1.0 / max(u_gammaC, 0.01)));
}`

const VIBRANCE = `
uniform float u_vibrance;    // -1..1
uniform float u_saturation;  // -1..1

vec3 adjust(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float chroma = mx - mn;
  float l = lumaPS(c);

  float amt = u_vibrance * (1.0 - chroma);
  // Protect skin: damp positive vibrance around the orange hue band.
  if (u_vibrance > 0.0 && chroma > EPS) {
    float h = rgb2hsl(c).x;
    float d = abs(h - 0.07);
    d = min(d, 1.0 - d);
    amt *= mix(1.0, 0.35, 1.0 - smoothstep(0.0, 0.09, d));
  }
  return mix(vec3(l), c, max(0.0, 1.0 + amt + u_saturation));
}`

const HUE_SATURATION = `
uniform vec3 u_master;        // hue frac, sat -1..1, light -1..1
uniform vec3 u_bands[6];      // reds, yellows, greens, cyans, blues, magentas
uniform bool u_colorize;
uniform vec3 u_colorizeHSL;   // hue frac, sat 0..1, light -1..1

// Photoshop's default ranges: full strength within 30 degrees of the band
// centre, feathering to zero by 60 degrees.
float bandWeight(float h, float center) {
  float d = abs(h - center);
  d = min(d, 1.0 - d);
  return 1.0 - smoothstep(1.0 / 12.0, 1.0 / 6.0, d);
}

vec3 adjust(vec3 c) {
  vec3 hsl = rgb2hsl(c);

  if (u_colorize) {
    float l = hsl.z;
    l = pushToward(l, u_colorizeHSL.z);
    return hsl2rgb(vec3(u_colorizeHSL.x, u_colorizeHSL.y, clamp(l, 0.0, 1.0)));
  }

  float dh = u_master.x, ds = u_master.y, dl = u_master.z;
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  if (chroma > EPS) {
    for (int i = 0; i < 6; i++) {
      float w = bandWeight(hsl.x, float(i) / 6.0);
      if (w > 0.0) {
        dh += u_bands[i].x * w;
        ds += u_bands[i].y * w;
        dl += u_bands[i].z * w;
      }
    }
  }

  hsl.x = fract(hsl.x + dh + 1.0);
  hsl.y = clamp(pushToward(hsl.y, ds), 0.0, 1.0);
  hsl.z = clamp(pushToward(hsl.z, dl), 0.0, 1.0);
  return hsl2rgb(hsl);
}`

const COLOR_BALANCE = `
uniform vec3 u_shadows, u_midtones, u_highlights;  // -1..1 per RGB axis
uniform bool u_preserveLum;

vec3 adjust(vec3 c) {
  const float a = 0.25, b = 0.333, scale = 0.7;
  vec3 sw = clamp((c - b) / -a + 0.5, 0.0, 1.0) * scale;
  vec3 mw = clamp((c - b) / a + 0.5, 0.0, 1.0)
          * clamp((c + b - 1.0) / -a + 0.5, 0.0, 1.0) * scale;
  vec3 hw = clamp((c + b - 1.0) / a + 0.5, 0.0, 1.0) * scale;

  vec3 o = clamp(c + u_shadows * sw + u_midtones * mw + u_highlights * hw, 0.0, 1.0);
  if (u_preserveLum) {
    vec3 h = rgb2hsl(o);
    h.z = rgb2hsl(c).z;
    o = hsl2rgb(h);
  }
  return o;
}`

const SELECTIVE_COLOR = `
// order: reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks
uniform vec4 u_sc[9];   // C, M, Y, K each -1..1
uniform bool u_relative;

vec3 applyCMYK(vec3 rgb, vec4 adj, float w) {
  if (w <= 0.0 || adj == vec4(0.0)) return rgb;
  vec3 cmy = 1.0 - rgb;
  vec3 nc = u_relative ? cmy + adj.xyz * cmy : cmy + adj.xyz;
  vec3 o = 1.0 - clamp(nc, 0.0, 1.0);
  o = u_relative ? o * (1.0 - adj.w) : o - adj.w;
  return mix(rgb, clamp(o, 0.0, 1.0), w);
}

vec3 adjust(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  float chroma = mx - mn;

  float wR = 0.0, wY = 0.0, wG = 0.0, wC = 0.0, wB = 0.0, wM = 0.0;
  if (chroma > EPS) {
    // Split the hue into its two neighbouring primaries/secondaries.
    float t = (md - mn) / chroma;
    if (mx == c.r && mn == c.b)      { wR = 1.0 - t; wY = t; }
    else if (mx == c.g && mn == c.b) { wG = 1.0 - t; wY = t; }
    else if (mx == c.g && mn == c.r) { wG = 1.0 - t; wC = t; }
    else if (mx == c.b && mn == c.r) { wB = 1.0 - t; wC = t; }
    else if (mx == c.b && mn == c.g) { wB = 1.0 - t; wM = t; }
    else                             { wR = 1.0 - t; wM = t; }
    float s = chroma / max(mx, EPS);   // HSV saturation gates the strength
    wR *= s; wY *= s; wG *= s; wC *= s; wB *= s; wM *= s;
  }

  float wWhite = clamp((mn - 0.5) * 2.0, 0.0, 1.0);
  float wBlack = clamp((0.5 - mx) * 2.0, 0.0, 1.0);
  float wNeutral = clamp(1.0 - wWhite - wBlack, 0.0, 1.0);

  vec3 o = c;
  o = applyCMYK(o, u_sc[0], wR);
  o = applyCMYK(o, u_sc[1], wY);
  o = applyCMYK(o, u_sc[2], wG);
  o = applyCMYK(o, u_sc[3], wC);
  o = applyCMYK(o, u_sc[4], wB);
  o = applyCMYK(o, u_sc[5], wM);
  o = applyCMYK(o, u_sc[6], wWhite);
  o = applyCMYK(o, u_sc[7], wNeutral);
  o = applyCMYK(o, u_sc[8], wBlack);
  return o;
}`

const REPLACE_COLOR = `
uniform vec3 u_target;
uniform float u_fuzz;      // 0..1
uniform vec3 u_shift;      // hue frac, sat -1..1, light -1..1
uniform bool u_showMask;

vec3 adjust(vec3 c) {
  vec3 h = rgb2hsl(c);
  vec3 t = rgb2hsl(u_target);

  float dh = abs(h.x - t.x);
  dh = min(dh, 1.0 - dh) * 2.0;                 // 0..1
  // Hue distance only matters when both colours actually have chroma.
  float chromaGate = min(h.y, t.y) * 2.0;
  dh *= clamp(chromaGate, 0.0, 1.0);
  float ds = abs(h.y - t.y);
  float dl = abs(h.z - t.z);
  float dist = sqrt(dh * dh * 2.0 + ds * ds * 0.8 + dl * dl * 0.8);

  float m = 1.0 - smoothstep(u_fuzz * 0.35, max(u_fuzz, 0.004), dist);
  if (u_showMask) return vec3(m);
  if (m <= 0.0) return c;

  vec3 o = h;
  o.x = fract(o.x + u_shift.x + 1.0);
  o.y = clamp(pushToward(o.y, u_shift.y), 0.0, 1.0);
  o.z = clamp(pushToward(o.z, u_shift.z), 0.0, 1.0);
  return mix(c, hsl2rgb(o), m);
}`

const BLACK_WHITE = `
uniform float u_w[6];        // reds..magentas, typically 0..1 (can exceed)
uniform bool u_tint;
uniform vec3 u_tintColor;

vec3 adjust(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  float chroma = mx - mn;

  float w = 0.0;
  if (chroma > EPS) {
    float t = (md - mn) / chroma;
    if (mx == c.r && mn == c.b)      w = mix(u_w[0], u_w[1], t);  // red -> yellow
    else if (mx == c.g && mn == c.b) w = mix(u_w[2], u_w[1], t);  // green -> yellow
    else if (mx == c.g && mn == c.r) w = mix(u_w[2], u_w[3], t);  // green -> cyan
    else if (mx == c.b && mn == c.r) w = mix(u_w[4], u_w[3], t);  // blue -> cyan
    else if (mx == c.b && mn == c.g) w = mix(u_w[4], u_w[5], t);  // blue -> magenta
    else                             w = mix(u_w[0], u_w[5], t);  // red -> magenta
  }

  float gray = clamp(mn + chroma * w, 0.0, 1.0);
  if (!u_tint) return vec3(gray);

  vec3 th = rgb2hsl(u_tintColor);
  return hsl2rgb(vec3(th.x, th.y, gray));
}`

const CHANNEL_MIXER = `
uniform vec3 u_mr, u_mg, u_mb;   // source contributions per output channel
uniform vec3 u_const;
uniform bool u_mono;
uniform vec3 u_gray;
uniform float u_grayConst;

vec3 adjust(vec3 c) {
  if (u_mono) return vec3(dot(c, u_gray) + u_grayConst);
  return vec3(dot(c, u_mr), dot(c, u_mg), dot(c, u_mb)) + u_const;
}`

const PHOTO_FILTER = `
uniform vec3 u_color;
uniform float u_density;   // 0..1
uniform bool u_preserveLum;

vec3 adjust(vec3 c) {
  vec3 o = mix(c, c * u_color, u_density);
  if (u_preserveLum) {
    float before = lumaPS(c);
    float after = lumaPS(o);
    o *= before / max(after, 1e-4);
  }
  return o;
}`

const GRADIENT_MAP = `
uniform sampler2D u_lut;   // 256x1 ramp

vec3 adjust(vec3 c) {
  float l = clamp(lumaPS(c), 0.0, 1.0);
  return texture(u_lut, vec2(l * (255.0 / 256.0) + (0.5 / 256.0), 0.5)).rgb;
}`

const COLOR_LOOKUP = `
uniform highp sampler3D u_cube;
uniform float u_lutSize;
uniform float u_amount;

vec3 adjust(vec3 c) {
  vec3 uvw = (clamp(c, 0.0, 1.0) * (u_lutSize - 1.0) + 0.5) / u_lutSize;
  return mix(c, texture(u_cube, uvw).rgb, u_amount);
}`

const SOLID_COLOR = `
uniform vec3 u_color;

vec3 adjust(vec3 c) {
  // The colour is unconditional; where it lands is the mask's job, and how it
  // combines is the blend mode's.
  return u_color;
}`

/**
 * Slider-to-gain strength. The gains are exponential, because illuminant
 * scaling is multiplicative: it keeps small settings gentle, gives the extremes
 * enough range to correct a tungsten shot, and makes the inverse exactly
 * solvable in log space. Exported so the eyedropper solves the same model the
 * shader applies rather than a copy that can drift.
 */
export const WB_GAIN = { temp: 0.9, tintGreen: 0.6, tintCross: 0.3 }

const WHITE_BALANCE = `
uniform float u_temp;         // -1 cool .. +1 warm
uniform float u_tint;         // -1 magenta .. +1 green
uniform bool u_preserveLum;

vec3 adjust(vec3 c) {
  // White balance is illuminant scaling, which only behaves correctly in
  // linear light: doing it on gamma-encoded values skews the highlights.
  // Exposure linearises for the same reason.
  vec3 lin = pow(max(c, 0.0), vec3(2.2));

  // Warming adds red and removes blue; tint trades green against magenta,
  // which is red and blue together.
  vec3 gain = exp(vec3(
     ${WB_GAIN.temp.toFixed(4)} * u_temp - ${WB_GAIN.tintCross.toFixed(4)} * u_tint,
     ${WB_GAIN.tintGreen.toFixed(4)} * u_tint,
    -${WB_GAIN.temp.toFixed(4)} * u_temp - ${WB_GAIN.tintCross.toFixed(4)} * u_tint
  ));
  vec3 o = pow(max(lin * max(gain, vec3(0.0)), 0.0), vec3(1.0 / 2.2));

  if (u_preserveLum) {
    float before = lumaPS(c);
    o *= before / max(lumaPS(o), 1e-4);
  }
  return o;
}`

// Neighbourhood ops read u_src / v_uv directly; the renderer always binds
// u_texel so these can sample a fixed pixel radius.
const HIGHLIGHTS_SHADOWS = `
uniform float u_highlights;  // -1..1
uniform float u_shadows;     // -1..1

vec3 adjust(vec3 c) {
  float y = lumaPS(c);
  // Soft masks so the two ends meet in the midtones without a hard seam.
  float hw = smoothstep(0.35, 0.85, y);
  float sw = 1.0 - smoothstep(0.15, 0.65, y);
  float h = u_highlights >= 0.0
    ? (1.0 - y) * u_highlights * hw
    : -y * (-u_highlights) * hw;
  float s = u_shadows >= 0.0
    ? (1.0 - y) * u_shadows * sw
    : -y * (-u_shadows) * sw;
  return c + (h + s);
}`

const CLARITY = `
uniform vec2 u_texel;
uniform float u_amount;  // -1..1

vec3 adjust(vec3 c) {
  // Wide soft blur — clarity is midtone local contrast, not fine edges.
  vec2 t = u_texel * 2.5;
  vec3 blur =
      texture(u_src, v_uv + vec2(-t.x, 0.0)).rgb
    + texture(u_src, v_uv + vec2( t.x, 0.0)).rgb
    + texture(u_src, v_uv + vec2(0.0, -t.y)).rgb
    + texture(u_src, v_uv + vec2(0.0,  t.y)).rgb
    + texture(u_src, v_uv + vec2(-t.x, -t.y)).rgb
    + texture(u_src, v_uv + vec2( t.x, -t.y)).rgb
    + texture(u_src, v_uv + vec2(-t.x,  t.y)).rgb
    + texture(u_src, v_uv + vec2( t.x,  t.y)).rgb;
  blur *= 0.125;
  float y = lumaPS(c);
  float mid = smoothstep(0.12, 0.35, y) * (1.0 - smoothstep(0.65, 0.88, y));
  return mix(c, c + (c - blur) * u_amount, mid);
}`

const SHARPNESS = `
uniform vec2 u_texel;
uniform float u_amount;  // -1..1

vec3 adjust(vec3 c) {
  vec2 t = u_texel;
  vec3 blur =
      texture(u_src, v_uv + vec2(-t.x, 0.0)).rgb
    + texture(u_src, v_uv + vec2( t.x, 0.0)).rgb
    + texture(u_src, v_uv + vec2(0.0, -t.y)).rgb
    + texture(u_src, v_uv + vec2(0.0,  t.y)).rgb;
  blur *= 0.25;
  return c + (c - blur) * u_amount;
}`

const GRAIN = `
uniform vec2 u_texel;
uniform float u_amount;  // 0..1
uniform float u_size;    // 0..1 — scales the noise cell

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 adjust(vec3 c) {
  if (u_amount < 1e-4) return c;
  // Coarser size → larger noise cells in pixel space.
  float cell = mix(1.0, 4.5, u_size);
  vec2 grid = floor(v_uv / max(u_texel * cell, vec2(1e-5)));
  float n = hash21(grid) - 0.5;
  // Slightly stronger in midtones; film grain is less visible in deep black.
  float y = lumaPS(c);
  float w = smoothstep(0.02, 0.18, y) * (1.0 - 0.35 * smoothstep(0.75, 1.0, y));
  return c + n * u_amount * 0.42 * w;
}`

const NOISE_REDUCTION = `
uniform vec2 u_texel;
uniform float u_amount;  // -1..1

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 adjust(vec3 c) {
  if (abs(u_amount) < 1e-4) return c;
  if (u_amount > 0.0) {
    vec2 t = u_texel;
    vec3 blur =
        texture(u_src, v_uv + vec2(-t.x, 0.0)).rgb
      + texture(u_src, v_uv + vec2( t.x, 0.0)).rgb
      + texture(u_src, v_uv + vec2(0.0, -t.y)).rgb
      + texture(u_src, v_uv + vec2(0.0,  t.y)).rgb
      + c;
    blur *= 0.2;
    return mix(c, blur, u_amount);
  }
  float n = hash21(floor(v_uv / max(u_texel, vec2(1e-5)))) - 0.5;
  return c + n * (-u_amount) * 0.28;
}`

const COLOR_CHROME = `
uniform float u_amount;  // 0..1
uniform float u_blue;    // 0..1

vec3 adjust(vec3 c) {
  vec3 o = c;
  if (u_amount > 1e-4) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float chroma = mx - mn;
    // Push saturated colours toward a denser, less flat look — deepen by
    // pulling the min channel down a little rather than boosting max.
    float fac = smoothstep(0.12, 0.55, chroma) * u_amount;
    float mean = (c.r + c.g + c.b) / 3.0;
    o = mix(o, mean + (o - mean) * (1.0 + fac * 0.55) - fac * 0.04, fac);
  }
  if (u_blue > 1e-4) {
    // Blue-dominant pixels only (sky / water), matching Color Chrome FX Blue.
    float blueDom = smoothstep(0.0, 0.2, o.b - max(o.r, o.g) * 0.95);
    o.b += (o.b - o.r) * u_blue * 0.45 * blueDom;
    o.g -= u_blue * 0.04 * blueDom;
  }
  return o;
}`

export const FRAG_BODIES: Record<AdjustmentKind, string> = {
  brightnessContrast: BRIGHTNESS_CONTRAST,
  levels: LEVELS,
  curves: CURVES,
  exposure: EXPOSURE,
  vibrance: VIBRANCE,
  hueSaturation: HUE_SATURATION,
  colorBalance: COLOR_BALANCE,
  selectiveColor: SELECTIVE_COLOR,
  replaceColor: REPLACE_COLOR,
  blackWhite: BLACK_WHITE,
  channelMixer: CHANNEL_MIXER,
  photoFilter: PHOTO_FILTER,
  gradientMap: GRADIENT_MAP,
  colorLookup: COLOR_LOOKUP,
  solidColor: SOLID_COLOR,
  whiteBalance: WHITE_BALANCE,
  highlightsShadows: HIGHLIGHTS_SHADOWS,
  clarity: CLARITY,
  sharpness: SHARPNESS,
  grain: GRAIN,
  noiseReduction: NOISE_REDUCTION,
  colorChrome: COLOR_CHROME,
}

export function buildFragment(kind: AdjustmentKind): string {
  return COMMON + FRAG_BODIES[kind]
}

// ---------------------------------------------------------------------------
// Mask generation. One pass per masked layer, run against that layer's input,
// producing a single-channel coverage map the adjustment then samples.
// ---------------------------------------------------------------------------

export const MASK_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_src;     // the layer's input, for the data-driven kinds
uniform sampler2D u_baked;   // baked brush strokes
uniform sampler2D u_seg;     // per-pixel class ids from the segmenter
uniform int u_segMask;       // bitmask of the classes this mask selects
uniform bool u_segReady;     // false until a segmentation has been uploaded
uniform int u_kind;          // 1 linear, 2 radial, 3 luminance, 4 colourRange, 5 brush, 6 segmented
uniform bool u_invert;
uniform float u_density;     // 0..1
uniform float u_feather;     // 0..1
uniform vec2 u_center;
uniform float u_angle;       // radians
uniform float u_size;
uniform float u_aspect;
uniform vec2 u_range;        // luminance lo/hi, 0..1
uniform vec3 u_target;
uniform float u_fuzz;
uniform vec2 u_texel;        // 1/size of the mask target, for feather taps

float lumaPS(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / max(2.0 - mx - mn, 1e-6) : d / max(mx + mn, 1e-6);
  float h;
  if (mx == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else                h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

/** Feathering the brush layer means blurring it; the analytic kinds already
    fold feather into their own falloff. */
float bakedBlurred(vec2 uv) {
  float r = u_feather * 0.06;
  if (r <= 0.0) return texture(u_baked, uv).r;
  float sum = 0.0, wsum = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;               // 12 taps around a ring
    for (int k = 1; k <= 2; k++) {
      vec2 off = vec2(cos(a), sin(a)) * r * float(k) * 0.5;
      float w = 1.0 / float(k);
      sum += texture(u_baked, uv + off).r * w;
      wsum += w;
    }
  }
  float centre = texture(u_baked, uv).r;
  return mix(centre, sum / wsum, 0.85);
}

/**
 * 1.0 where the pixel's class is one of the selected ones.
 *
 * The texture holds class *ids*, so it is sampled NEAREST and decoded here —
 * interpolating between class 1 and class 3 would invent a class 2 along every
 * boundary. Selection is a bitmask so unions like "all skin" cost one test.
 */
float segAt(vec2 uv) {
  int cls = int(texture(u_seg, uv).r * 255.0 + 0.5);
  if (cls < 0 || cls > 30) return 0.0;
  return ((u_segMask >> cls) & 1) == 1 ? 1.0 : 0.0;
}

/**
 * The segmenter's edge is hard and sits at model resolution, so it stair-steps
 * when scaled up to a photograph. Feather averages a ring around each pixel,
 * the same treatment the brush gets.
 */
float segBlurred(vec2 uv) {
  if (u_feather <= 0.0) return segAt(uv);
  float r = u_feather * 0.04;
  float sum = 0.0, wsum = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    for (int k = 1; k <= 2; k++) {
      vec2 off = vec2(cos(a), sin(a)) * r * float(k) * 0.5;
      float w = 1.0 / float(k);
      sum += segAt(uv + off) * w;
      wsum += w;
    }
  }
  return mix(segAt(uv), sum / wsum, 0.85);
}

float maskValue(vec2 uv) {
  if (u_kind == 6) return segBlurred(uv);
  if (u_kind == 1) {
    // signed distance along the gradient axis, in image-space units
    vec2 d = uv - u_center;
    vec2 dir = vec2(cos(u_angle), sin(u_angle));
    float t = dot(d, dir) / max(u_size, 1e-4);
    float soft = 0.5 + u_feather * 2.0;
    return clamp(0.5 - t / max(soft, 1e-4), 0.0, 1.0);
  }
  if (u_kind == 2) {
    vec2 d = uv - u_center;
    float ca = cos(-u_angle), sa = sin(-u_angle);
    d = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
    d.y /= max(u_aspect, 1e-4);
    float r = length(d) / max(u_size, 1e-4);
    float soft = 0.15 + u_feather * 1.2;
    return 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.15, r);
  }
  if (u_kind == 3) {
    float l = lumaPS(clamp(texture(u_src, uv).rgb, 0.0, 1.0));
    float soft = 0.02 + u_feather * 0.5;
    // plateau between lo and hi, feathered on both sides
    return smoothstep(u_range.x - soft, u_range.x + soft, l)
         * (1.0 - smoothstep(u_range.y - soft, u_range.y + soft, l));
  }
  if (u_kind == 4) {
    vec3 c = clamp(texture(u_src, uv).rgb, 0.0, 1.0);
    vec3 h = rgb2hsl(c);
    vec3 t = rgb2hsl(u_target);
    float dh = abs(h.x - t.x);
    dh = min(dh, 1.0 - dh) * 2.0;
    dh *= clamp(min(h.y, t.y) * 2.0, 0.0, 1.0);   // hue only matters with chroma
    float ds = abs(h.y - t.y);
    float dl = abs(h.z - t.z);
    float dist = sqrt(dh * dh * 2.0 + ds * ds * 0.8 + dl * dl * 0.8);
    return 1.0 - smoothstep(u_fuzz * 0.35, max(u_fuzz, 0.004), dist);
  }
  if (u_kind == 5) return bakedBlurred(uv);
  return 1.0;
}

void main() {
  float m = clamp(maskValue(v_uv), 0.0, 1.0);
  if (u_invert) m = 1.0 - m;
  // A segmented mask with nothing uploaded yet must cover nothing, and invert
  // has to be applied before that is decided: inverting the empty placeholder
  // would otherwise turn "not ready" into "the whole frame", so an inverted
  // subject mask flashed its adjustment across the photo while the model loaded.
  if (u_kind == 6 && !u_segReady) m = 0.0;
  fragColor = vec4(vec3(m * u_density), 1.0);
}`

/**
 * Brush dabs, drawn instanced: one instance per dab, one draw call per stroke.
 * a_dab is (x, y, radius, value) in normalised image space.
 */
export const BRUSH_VERT = `#version 300 es
in vec2 a_pos;          // unit quad, -1..1
in vec4 a_dab;
out vec2 v_local;
out float v_value;
uniform float u_aspect;  // width / height, to keep dabs round

void main() {
  v_local = a_pos;
  v_value = a_dab.w;
  vec2 r = vec2(a_dab.z, a_dab.z * u_aspect);
  vec2 p = a_dab.xy + a_pos * r;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const BRUSH_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
in float v_value;
out vec4 fragColor;
uniform float u_hardness;   // 0..1
uniform bool u_erase;

void main() {
  float d = length(v_local);
  if (d > 1.0) discard;
  // hardness controls where the falloff starts
  float inner = clamp(u_hardness, 0.0, 0.98);
  float a = 1.0 - smoothstep(inner, 1.0, d);
  float v = a * v_value;
  // MAX blending when adding, MIN when erasing, so a single stroke does not
  // build up on itself where it overlaps.
  fragColor = vec4(vec3(u_erase ? 1.0 - v : v), 1.0);
}`

/** Straight copy — used to resolve into 8-bit buffers for histogram and export. */
export const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() { fragColor = vec4(clamp(texture(u_tex, v_uv).rgb, 0.0, 1.0), 1.0); }`

/** Presentation pass: zoom/pan, checkerboard backdrop and before/after compare. */
export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_result;
uniform sampler2D u_original;
uniform vec2 u_canvasSize;
uniform vec2 u_imageSize;
uniform float u_zoom;
uniform vec2 u_pan;
uniform int u_compare;      // 0 result, 1 split, 2 original
uniform float u_split;      // 0..1 split position in canvas space
uniform sampler2D u_maskView;
uniform int u_maskMode;     // 0 off, 1 red overlay, 2 mask only
uniform vec3 u_surround;    // backdrop the photo is matted against

void main() {
  // Textures are stored top-down (UNPACK_FLIP_Y_WEBGL cannot be used with
  // ImageBitmap sources), so flip the screen axis here instead.
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_canvasSize;
  vec2 centred = p - u_canvasSize * 0.5 - u_pan;
  vec2 imgPx = centred / max(u_zoom, 1e-4) + u_imageSize * 0.5;
  vec2 uv = imgPx / u_imageSize;

  // A flat neutral mat. Checkerboard would mean transparency, which is not
  // what is outside an opaque photograph.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(u_surround, 1.0);
    return;
  }

  bool showOriginal = u_compare == 2 || (u_compare == 1 && v_uv.x < u_split);
  vec3 c = showOriginal ? texture(u_original, uv).rgb : texture(u_result, uv).rgb;

  if (u_maskMode != 0) {
    float m = texture(u_maskView, uv).r;
    // quick-mask convention: red shows the *protected* area
    if (u_maskMode == 2) c = vec3(m);
    else c = mix(vec3(0.85, 0.1, 0.15), c, m * 0.65 + 0.35);
  }
  fragColor = vec4(c, 1.0);

  if (u_compare == 1) {
    float edge = abs(v_uv.x - u_split) * u_canvasSize.x;
    if (edge < 1.0) fragColor = vec4(1.0);
  }
}`
