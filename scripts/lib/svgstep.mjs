// The SVG step: tools for redrawing ONE chosen candidate as a vector. Whoever draws the SVG (Claude, by numbers): these
// functions only measure the picture so the drawing can be done by numbers, and compare a drawing with the picture. Pure
// except for `withRenderer`, which is the one place that starts a browser (or another renderer) and only when this step runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePng, decodePng } from './png.mjs';
import { resizeArea } from './pixels.mjs';
import { discoverRenderers, noRendererMessage, renderSvgPng } from './renderers.mjs';

const VISIBLE = 128; // alpha at or above this is part of the shape
const SOLID = 250; // alpha at or above this is a flat-colour pixel (not the soft edge)
const JOIN_DISTANCE = 32; // two colours closer than this (RGB distance) are one palette colour
const BLEND_DISTANCE = 30; // a shade this close to the line between two palette colours may be only their soft edge
const BLOB_SHARE = 0.25; // ... unless at least this share of it forms solid areas
const MIN_RUN = 3; // a run shorter than this is the soft edge between two colours and is folded into its neighbour
const LETTERS = 'ABCDEFGHIJKLMNOP';
const COLOUR_TOLERANCE = 64; // both visible and a channel differing by more than this = a colour mismatch
const BLOCK = 64;
const EDGE_BAND_PER_512 = 1; // a difference this many pixels (per 512 px of master) from an edge of the master is a matter of anti-aliasing, not of the drawing

const hex = (r, g, b) => `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const round1 = (value) => Math.round(value * 10) / 10;

/** Evenly spaced whole numbers from `from` to `to`, `count` of them. */
function spaced(from, to, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(Math.round(from + ((to - from) * i) / Math.max(1, count - 1)));
  return [...new Set(out)];
}

/** Distance from point p to the segment a-b (3-D). */
function segmentDistance(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const length = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / length));
  return Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]), p[2] - (a[2] + t * ab[2]));
}

/**
 * The palette of a master: its flat colours, each with its area share, bounding box and the letter the scanline runs use; and
 * `assign`, the palette index of every pixel (-1 for transparent). A colour is kept when it is not a blend: a shade that lies
 * on the line between two stronger colours and only forms thin bands (the soft edge between them) is dropped, while a pale
 * blob that happens to be near white (an eye) stays.
 */
function paletteOf(rgba, size, count) {
  const total = size * size;
  const keys = new Int32Array(total).fill(-1);
  const bins = new Map();
  for (let index = 0; index < total; index += 1) {
    const o = index * 4;
    if (rgba[o + 3] < SOLID) continue;
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    keys[index] = key;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const ordered = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48);
  const candidates = new Set(ordered.map(([key]) => key));
  // how much of each candidate colour is a blob (its pixels have the same colour two pixels away on every side) and not a thin band
  const interior = new Map(ordered.map(([key]) => [key, 0]));
  for (let y = 2; y < size - 2; y += 1) {
    for (let x = 2; x < size - 2; x += 1) {
      const index = y * size + x;
      const key = keys[index];
      if (key < 0 || !candidates.has(key)) continue;
      if (keys[index - 2] === key && keys[index + 2] === key && keys[index - 2 * size] === key && keys[index + 2 * size] === key) interior.set(key, interior.get(key) + 1);
    }
  }
  const centres = [];
  for (const [key, n] of ordered) {
    if (centres.length >= count) break;
    const colour = [((key >> 10) << 3) + 4, (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4];
    if (centres.some((centre) => Math.hypot(centre[0] - colour[0], centre[1] - colour[1], centre[2] - colour[2]) <= JOIN_DISTANCE)) continue;
    let blend = false;
    for (let i = 0; i < centres.length && !blend; i += 1) {
      for (let j = i + 1; j < centres.length && !blend; j += 1) if (segmentDistance(colour, centres[i], centres[j]) < BLEND_DISTANCE) blend = true;
    }
    if (blend && interior.get(key) / n < BLOB_SHARE) continue;
    centres.push(colour);
  }
  const assign = new Int8Array(total).fill(-1);
  const sums = centres.map(() => ({ n: 0, r: 0, g: 0, b: 0, x0: size, y0: size, x1: -1, y1: -1, sx: 0, sy: 0 }));
  for (let index = 0; index < total; index += 1) {
    const o = index * 4;
    if (rgba[o + 3] < VISIBLE || centres.length === 0) continue;
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k < centres.length; k += 1) {
      const distance = (rgba[o] - centres[k][0]) ** 2 + (rgba[o + 1] - centres[k][1]) ** 2 + (rgba[o + 2] - centres[k][2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    assign[index] = best;
    if (rgba[o + 3] >= SOLID) {
      const x = index % size;
      const y = (index - x) / size;
      const sum = sums[best];
      sum.n += 1;
      sum.r += rgba[o];
      sum.g += rgba[o + 1];
      sum.b += rgba[o + 2];
      sum.sx += x;
      sum.sy += y;
      if (x < sum.x0) sum.x0 = x;
      if (x > sum.x1) sum.x1 = x;
      if (y < sum.y0) sum.y0 = y;
      if (y > sum.y1) sum.y1 = y;
    }
  }
  const solid = sums.reduce((sum, item) => sum + item.n, 0);
  const palette = sums
    .map((sum, k) => ({ k, sum }))
    .filter(({ sum }) => sum.n > 0)
    .sort((a, b) => b.sum.n - a.sum.n)
    .map(({ k, sum }, rank) => ({
      letter: LETTERS[rank],
      original: k,
      hex: hex(sum.r / sum.n, sum.g / sum.n, sum.b / sum.n),
      sharePercent: round1((100 * sum.n) / Math.max(1, solid)),
      box: { x0: sum.x0, y0: sum.y0, x1: sum.x1, y1: sum.y1 },
      centre: { x: round1(sum.sx / sum.n), y: round1(sum.sy / sum.n) },
    }));
  // the pixels point at the palette entry's letter rank
  const rankOf = new Map(palette.map((entry, rank) => [entry.original, rank]));
  for (let index = 0; index < total; index += 1) if (assign[index] >= 0) assign[index] = rankOf.get(assign[index]) ?? -1;
  return { palette: palette.map(({ original, ...entry }) => entry), assign };
}

/** One scanline (a row when `row` is true, else a column) as runs: "T0-231 B232-262 ...", T for transparent, short runs folded in. */
export function runsOf(assign, size, line, row) {
  const runs = [];
  for (let i = 0; i < size; i += 1) {
    const value = assign[row ? line * size + i : i * size + line];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.value === value) last.end = i;
    else runs.push({ value, start: i, end: i });
  }
  // fold the soft edge between two colours into the longer neighbour
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < runs.length && runs.length > 1; i += 1) {
      const length = runs[i].end - runs[i].start + 1;
      if (length >= MIN_RUN) continue;
      const left = runs[i - 1];
      const right = runs[i + 1];
      const target = left === undefined ? right : right === undefined ? left : left.end - left.start >= right.end - right.start ? left : right;
      if (target === left) left.end = runs[i].end;
      else right.start = runs[i].start;
      runs.splice(i, 1);
      changed = true;
      break;
    }
  }
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.value === run.value) last.end = run.end;
    else merged.push({ ...run });
  }
  return merged.map((run) => `${run.value < 0 ? 'T' : LETTERS[run.value]}${run.start}-${run.end}`).join(' ');
}

/**
 * Measure a prepared master (the picture the pack is built from) so it can be redrawn as an SVG by numbers: the size to draw
 * on (`viewBox`), the shape's bounding box, the flat colours with area, box and centre, how mirror-symmetric it is, and
 * scanlines: for each requested row and column the runs of colour along it, in the master's own pixel coordinates.
 */
export function measureMaster(prepared, { rows = null, cols = null, colours = 8 } = {}) {
  const { size, rgba } = prepared;
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] < VISIBLE) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('nothing is visible in this master, so there is nothing to measure');
  const { palette, assign } = paletteOf(rgba, size, Math.max(2, Math.min(LETTERS.length, colours)));
  const axis = (x0 + x1 + 1) / 2;
  let overlap = 0;
  let union = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const mirrored = Math.round(2 * axis - x - 1);
      const a = rgba[(y * size + x) * 4 + 3] >= VISIBLE;
      const b = mirrored >= 0 && mirrored < size && rgba[(y * size + mirrored) * 4 + 3] >= VISIBLE;
      if (a && b) overlap += 1;
      if (a || b) union += 1;
    }
  }
  const rowList = rows ?? spaced(y0 + Math.round((y1 - y0) * 0.1), y0 + Math.round((y1 - y0) * 0.9), 9);
  const colList = cols ?? spaced(x0 + Math.round((x1 - x0) * 0.1), x0 + Math.round((x1 - x0) * 0.9), 9);
  const scanlines = { rows: {}, columns: {} };
  for (const y of rowList) if (y >= 0 && y < size) scanlines.rows[`y=${y}`] = runsOf(assign, size, y, true);
  for (const x of colList) if (x >= 0 && x < size) scanlines.columns[`x=${x}`] = runsOf(assign, size, x, false);
  return {
    size,
    viewBox: `0 0 ${size} ${size}`,
    shape: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, mirrorAxisX: axis, mirrorOverlapPercent: round1((100 * overlap) / Math.max(1, union)) },
    palette,
    scanlines,
    note: 'Coordinates are pixels of the master, y down. In a scanline a letter is a palette colour, T is transparent; runs shorter than 3 px (the soft edge) are folded into a neighbour.',
  };
}

/**
 * Compare a drawing (rendered at the master's size) with the master. Returns the numbers and the three-panel picture:
 * { metrics, panel (PNG Buffer) }. `metrics.worstBlocks` are the 64 px blocks that differ most, so the next change goes where it matters.
 */
export function compareToMaster(master, rendered, size) {
  const total = size * size;
  const kind = new Uint8Array(total); // 0 match, 1 only in the master, 2 only in the drawing, 3 colour differs, 4 differs but within the soft edge of the master
  const soft = edgeBand(master, size, Math.max(1, Math.round((size / 512) * EDGE_BAND_PER_512)));
  let union = 0;
  let both = 0;
  const counts = [0, 0, 0, 0, 0];
  const blocks = Math.ceil(size / BLOCK);
  const blockMismatch = new Float64Array(blocks * blocks);
  const blockKind = Array.from({ length: blocks * blocks }, () => [0, 0, 0, 0]);
  for (let index = 0; index < total; index += 1) {
    const o = index * 4;
    const a = master[o + 3] >= VISIBLE;
    const b = rendered[o + 3] >= VISIBLE;
    if (!a && !b) continue;
    union += 1;
    let k = 0;
    if (a && !b) k = 1;
    else if (!a && b) k = 2;
    else {
      both += 1;
      if (Math.max(Math.abs(master[o] - rendered[o]), Math.abs(master[o + 1] - rendered[o + 1]), Math.abs(master[o + 2] - rendered[o + 2])) > COLOUR_TOLERANCE) k = 3;
    }
    if (k > 0 && soft[index] === 1) {
      kind[index] = 4;
      counts[4] += 1;
      continue;
    }
    kind[index] = k;
    if (k > 0) {
      counts[k] += 1;
      const x = index % size;
      const y = (index - x) / size;
      const block = Math.floor(y / BLOCK) * blocks + Math.floor(x / BLOCK);
      blockMismatch[block] += 1;
      blockKind[block][k] += 1;
    }
  }
  const mismatch = counts[1] + counts[2] + counts[3];
  const percent = (n) => round1((100 * n) / Math.max(1, union));
  const worstBlocks = [...blockMismatch.keys()]
    .map((block) => ({ block, count: blockMismatch[block] }))
    .filter((entry) => entry.count >= BLOCK * BLOCK * 0.01)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(({ block, count }) => {
      const kinds = blockKind[block];
      const top = [1, 2, 3].sort((p, q) => kinds[q] - kinds[p])[0];
      const bx = (block % blocks) * BLOCK;
      const by = Math.floor(block / blocks) * BLOCK;
      return {
        x: bx,
        y: by,
        width: Math.min(BLOCK, size - bx),
        height: Math.min(BLOCK, size - by),
        mismatchPercentOfBlock: round1((100 * count) / (BLOCK * BLOCK)),
        mostly: top === 1 ? 'the master has ink here and the drawing does not' : top === 2 ? 'the drawing has ink here and the master does not' : 'both have ink here, in different colours',
      };
    });
  const metrics = {
    size,
    mismatchPercent: percent(mismatch),
    silhouetteOverlapPercent: round1((100 * (both + 0)) / Math.max(1, union)),
    onlyInMasterPercent: percent(counts[1]),
    onlyInDrawingPercent: percent(counts[2]),
    colourDiffersPercent: percent(counts[3]),
    softEdgePercent: percent(counts[4]),
    worstBlocks,
  };
  metrics.verdict = metrics.mismatchPercent <= 2 ? 'close' : metrics.mismatchPercent <= 6 ? 'near' : 'off';
  return { metrics, panel: panelPicture(master, rendered, kind, size) };
}

/**
 * 1 for every pixel within `width` pixels of an edge of the master (a visible/clear border, or a colour change of more than the
 * tolerance between neighbours): where a drawing may differ by anti-aliasing alone.
 */
function edgeBand(rgba, size, width) {
  const total = size * size;
  const edge = new Uint8Array(total);
  const differs = (a, b) => {
    const va = rgba[a * 4 + 3] >= VISIBLE;
    const vb = rgba[b * 4 + 3] >= VISIBLE;
    if (va !== vb) return true;
    if (!va) return false;
    return Math.max(Math.abs(rgba[a * 4] - rgba[b * 4]), Math.abs(rgba[a * 4 + 1] - rgba[b * 4 + 1]), Math.abs(rgba[a * 4 + 2] - rgba[b * 4 + 2])) > COLOUR_TOLERANCE;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      if ((x < size - 1 && differs(index, index + 1)) || (y < size - 1 && differs(index, index + size))) {
        edge[index] = 1;
        if (x < size - 1) edge[index + 1] = 1;
        if (y < size - 1) edge[index + size] = 1;
      }
    }
  }
  if (width <= 1) return edge;
  let grown = edge;
  for (let step = 1; step < width; step += 1) {
    const next = Uint8Array.from(grown);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x;
        if (grown[index] === 1) continue;
        if ((x > 0 && grown[index - 1] === 1) || (x < size - 1 && grown[index + 1] === 1) || (y > 0 && grown[index - size] === 1) || (y < size - 1 && grown[index + size] === 1)) next[index] = 1;
      }
    }
    grown = next;
  }
  return grown;
}

/** master | drawing | difference, side by side on white: red = only in the master, blue = only in the drawing, orange = colour differs, pale tan = differs only within the soft edge. */
function panelPicture(master, rendered, kind, size) {
  const panel = Math.min(size, 512);
  const gap = 8;
  const width = 3 * panel + 2 * gap;
  const canvas = Buffer.alloc(width * panel * 4, 255);
  const onWhite = (rgba, scaled) => {
    const out = Buffer.alloc(scaled * scaled * 4);
    const small = size === scaled ? rgba : resizeArea(rgba, size, size, scaled, scaled);
    for (let i = 0; i < scaled * scaled; i += 1) {
      const alpha = small[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.round(small[i * 4 + c] * alpha + 255 * (1 - alpha));
      out[i * 4 + 3] = 255;
    }
    return out;
  };
  const left = onWhite(master, panel);
  const middle = onWhite(rendered, panel);
  const diff = Buffer.alloc(panel * panel * 4);
  const scale = size / panel;
  for (let y = 0; y < panel; y += 1) {
    for (let x = 0; x < panel; x += 1) {
      // the strongest kind in the block of source pixels this panel pixel covers
      let k = 0;
      const sy0 = Math.floor(y * scale);
      const sx0 = Math.floor(x * scale);
      for (let yy = sy0; yy < Math.min(size, Math.floor((y + 1) * scale) + (scale > 1 ? 0 : 1)); yy += 1) {
        for (let xx = sx0; xx < Math.min(size, Math.floor((x + 1) * scale) + (scale > 1 ? 0 : 1)); xx += 1) {
          const value = kind[yy * size + xx];
          if (value > k) k = value;
        }
      }
      const i = (y * panel + x) * 4;
      const ghost = 255 - Math.round((255 - left[i]) * 0.18);
      const colour = k === 1 ? [220, 40, 40] : k === 2 ? [40, 90, 220] : k === 3 ? [235, 140, 20] : k === 4 ? [236, 222, 190] : [ghost, ghost, ghost];
      diff[i] = colour[0];
      diff[i + 1] = colour[1];
      diff[i + 2] = colour[2];
      diff[i + 3] = 255;
    }
  }
  [left, middle, diff].forEach((image, index) => {
    for (let y = 0; y < panel; y += 1) image.copy(canvas, (y * width + index * (panel + gap)) * 4, y * panel * 4, (y + 1) * panel * 4);
  });
  return encodePng(width, panel, canvas);
}

/** The renderer for this step, found only now (measure does not need one). */
export function findRenderer(discover = discoverRenderers) {
  const found = discover({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  if (!found.chosen) {
    throw new Error(`The SVG step needs a program that can draw an SVG, and none was found.\n${noRendererMessage()}`);
  }
  return found.chosen;
}

/**
 * Run `body(render)` with a scratch folder and a renderer, and clean the scratch folder afterwards (it holds only the throwaway
 * browser profile and the pictures it drew). `render(svgPath, size)` returns the RGBA Buffer of the SVG drawn at `size` px on a
 * transparent background.
 */
export async function withRenderer(body, { renderer = null } = {}) {
  const chosen = renderer ?? findRenderer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-svg-'));
  let counter = 0;
  try {
    const render = async (svgPath, size) => {
      counter += 1;
      const out = path.join(base, `render-${counter}-${size}.png`);
      await renderSvgPng({ svgPath, size, outPath: out, renderer: chosen, tempDir: base });
      return decodePng(fs.readFileSync(out)).rgba;
    };
    return await body(render, chosen);
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
    } catch {
      // a browser that was just stopped can hold profile files for a moment; the folder only holds scratch data in the OS temp folder
    }
  }
}
