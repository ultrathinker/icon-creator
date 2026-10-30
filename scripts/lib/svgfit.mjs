// "How well will this picture redraw as an SVG?" A flat picture with few colours and a bold outline can be redrawn by numbers
// (circles, arcs, a few curves) and comes out cleaner than the original pixels; a soft 3D render, a glow or a gradient cannot.
// The answer is computed, not guessed: how few colours cover the picture, how much of it is smooth shading, whether a dark
// outline runs round it, how symmetric it is. It is an estimate, said as one of three levels with the reasons, never as a
// promise. Pure functions; no file access.

import { resizeArea } from './pixels.mjs';

const WORK = 256; // the picture is measured at this size, whatever the master is
const ALPHA_VISIBLE = 128;
const STEP = 3; // a pixel is compared with the ones this far to its right and below, so a slow gradient shows as a difference
const STRONG_EDGE = 40; // pixels STEP apart differing by more than this (any channel) are across an edge
const SMOOTH_MIN = 3; // ... by 3 or less they are the same flat colour; in between they are shading
const DARK = 70; // an outline pixel: every channel at most this

export const LEVELS = Object.freeze({ high: 75, medium: 50 });

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Grow a 0/1 mask by `radius` pixels (square neighbourhood), separably. */
function grow(mask, width, height, radius) {
  const pass = (source, horizontal) => {
    const out = new Uint8Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let hit = 0;
        for (let k = -radius; k <= radius && hit === 0; k += 1) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx >= 0 && xx < width && yy >= 0 && yy < height && source[yy * width + xx] === 1) hit = 1;
        }
        out[y * width + x] = hit;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/**
 * The numbers behind the estimate, measured on the picture: `topShare` (the share of the visible pixels in its six commonest
 * colours), `shaded` (the share of the inside that is smooth shading rather than flat colour or a hard edge), `outline` (the share
 * of the rim that is dark), `symmetry` (left-right overlap of the shape). Returns null when nothing is visible.
 */
export function measureForSvg(rgba, size) {
  const small = size === WORK ? rgba : resizeArea(rgba, size, size, WORK, WORK);
  const total = WORK * WORK;
  const visible = new Uint8Array(total);
  let count = 0;
  for (let index = 0; index < total; index += 1) {
    if (small[index * 4 + 3] >= ALPHA_VISIBLE) {
      visible[index] = 1;
      count += 1;
    }
  }
  if (count < 100) return null;

  const bins = new Uint32Array(4096);
  for (let index = 0; index < total; index += 1) {
    if (visible[index] === 0) continue;
    const o = index * 4;
    bins[((small[o] >> 4) << 8) | ((small[o + 1] >> 4) << 4) | (small[o + 2] >> 4)] += 1;
  }
  const sorted = Array.from(bins).sort((a, b) => b - a);
  const topShare = sorted.slice(0, 6).reduce((sum, value) => sum + value, 0) / count;
  const colours = sorted.filter((value) => value / count >= 0.01).length;

  // the difference between a pixel and the ones STEP to its right and below, over the whole picture
  const difference = new Uint8Array(total);
  for (let y = 0; y < WORK; y += 1) {
    for (let x = 0; x < WORK; x += 1) {
      const index = y * WORK + x;
      const o = index * 4;
      let largest = 0;
      for (const next of [x < WORK - STEP ? index + STEP : -1, y < WORK - STEP ? index + STEP * WORK : -1]) {
        if (next < 0) continue;
        const n = next * 4;
        largest = Math.max(largest, Math.abs(small[o] - small[n]), Math.abs(small[o + 1] - small[n + 1]), Math.abs(small[o + 2] - small[n + 2]));
      }
      difference[index] = Math.min(255, largest);
    }
  }
  const strong = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) strong[index] = difference[index] > STRONG_EDGE ? 1 : 0;
  const nearEdge = grow(strong, WORK, WORK, STEP);
  const outside = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) outside[index] = visible[index] === 0 ? 1 : 0;
  const rim = grow(outside, WORK, WORK, 3);
  const nearOutside = grow(outside, WORK, WORK, 2);
  let inner = 0;
  let shaded = 0;
  let rimCount = 0;
  let rimDark = 0;
  for (let index = 0; index < total; index += 1) {
    if (visible[index] === 0) continue;
    const o = index * 4;
    if (nearOutside[index] === 0) {
      inner += 1;
      if (difference[index] > SMOOTH_MIN && difference[index] <= STRONG_EDGE && nearEdge[index] === 0) shaded += 1;
    }
    if (rim[index] === 1) {
      rimCount += 1;
      if (small[o] <= DARK && small[o + 1] <= DARK && small[o + 2] <= DARK) rimDark += 1;
    }
  }

  let overlap = 0;
  let union = 0;
  for (let y = 0; y < WORK; y += 1) {
    for (let x = 0; x < WORK; x += 1) {
      const a = visible[y * WORK + x];
      const b = visible[y * WORK + (WORK - 1 - x)];
      if (a === 1 && b === 1) overlap += 1;
      if (a === 1 || b === 1) union += 1;
    }
  }
  return {
    topShare,
    colours,
    shaded: inner === 0 ? 0 : shaded / inner,
    outline: rimCount === 0 ? 0 : rimDark / rimCount,
    symmetry: union === 0 ? 0 : overlap / union,
  };
}

/** The estimate: { score (0-100), level ('high' | 'medium' | 'low'), reasons: [text], measured }. */
export function svgFit({ rgba, size }) {
  const measures = measureForSvg(rgba, size);
  if (measures === null) return { score: 0, level: 'low', reasons: ['nothing visible to redraw'], measured: null };
  const colour = clamp01((measures.topShare - 0.45) / 0.4);
  const shading = 1 - clamp01(measures.shaded / 0.15);
  const outline = clamp01(measures.outline / 0.6);
  const score = Math.round(100 * (0.5 * colour + 0.4 * shading + 0.1 * outline));
  const level = score >= LEVELS.high ? 'high' : score >= LEVELS.medium ? 'medium' : 'low';

  const reasons = [];
  if (colour >= 0.75) reasons.push(`flat colours: ${measures.colours} cover ${Math.round(measures.topShare * 100)} % of the picture`);
  else if (colour <= 0.4) reasons.push(`many blended colours (the six commonest cover only ${Math.round(measures.topShare * 100)} %)`);
  if (measures.shaded >= 0.06) reasons.push(`soft shading or gradients on ${Math.round(measures.shaded * 100)} % of the inside`);
  if (measures.outline >= 0.6) reasons.push('a dark outline runs round it');
  if (measures.symmetry >= 0.9) reasons.push('symmetric, so one half can be mirrored');
  return { score, level, reasons, measured: { ...measures } };
}
