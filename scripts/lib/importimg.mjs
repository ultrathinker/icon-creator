// The `import` step: turn a user-supplied image into a prepared master that
// the existing commands (render, sheet, check, export) accept unchanged: a
// square transparent PNG plus a wrapper SVG that embeds it as a raster data
// URL (the only kind of embedded image the validator allows).

import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, analyzeRgba } from './png.mjs';
import { loadSource, decodeGifFirstFrame, assertDimensions } from './imagefile.mjs';
import { validateSvg } from './svgcheck.mjs';
import { browserDecodeSize } from './renderers.mjs';
import { sanitizeName, ensureRealDir, publishFile } from './export.mjs';
import { resolveNamedPath } from './publish.mjs';
import { borderReference, cornersUniform, cornerPixels, meanColor, removeBackground, resizeArea, fitToSquare } from './pixels.mjs';

export const MASTER_SIZE = 1024;
export const DEFAULT_TOLERANCE = 32;
export const MAX_TOLERANCE = 120;
export const MIN_SIDE = 16;
export const BACKGROUND_MODES = ['auto', 'keep', 'remove'];

// Warning thresholds, kept in one place so the messages and the tests agree.
const LOW_RESOLUTION = 512; // shorter source than this makes big sizes soft
const HEAVY_PADDING = 0.5; // the artwork box covers less than this share in BOTH directions, i.e. under its square (a quarter of the area)
const EDGE_MARGIN = 0.01; // artwork closer than this share of the side to an edge
const HEAVY_REMOVAL = 0.75; // share of pixels removed that makes us suspicious
const MUSH_INK = 0.12; // visible share at 16 px below which little is left
const MUSH_CONTRAST = 10; // luminance spread at 16 px below which it is a blob

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Bring a decoded picture down to the working size (longer side at most
 * BROWSER_DECODE_MAX px, the same size the browser decodes at). The master is
 * never bigger than 1024 px, so nothing visible is lost, and the background
 * work then needs memory for at most about four million pixels.
 */
function toWorkingSize(decoded) {
  const target = browserDecodeSize(decoded.width, decoded.height);
  if (target.width === decoded.width && target.height === decoded.height) return decoded;
  return { ...decoded, width: target.width, height: target.height, rgba: resizeArea(decoded.rgba, decoded.width, decoded.height, target.width, target.height) };
}

/**
 * Decode the loaded source to RGBA. PNG goes through the built-in codec
 * (anything it cannot handle, such as 16-bit or interlaced files, falls back
 * to the browser), GIF through the built-in first-frame decoder, JPEG/WebP/BMP
 * through `browserDecode({ imagePath, width, height })`.
 */
export async function decodeSource(source, { browserDecode = null } = {}) {
  const { format, buffer, width, height, path: file } = source;
  if (format === 'png') {
    try {
      const decoded = decodePng(buffer);
      return toWorkingSize({ width: decoded.width, height: decoded.height, rgba: decoded.rgba, via: 'built-in PNG codec', frames: 1 });
    } catch (error) {
      if (!/Unsupported PNG/.test(error.message)) throw new Error(`${file} is not a readable PNG: ${error.message}`);
    }
  } else if (format === 'gif') {
    try {
      const decoded = decodeGifFirstFrame(buffer);
      return toWorkingSize({ width: decoded.width, height: decoded.height, rgba: decoded.rgba, via: 'built-in GIF decoder', frames: decoded.frames });
    } catch (error) {
      throw new Error(`${file} is not a readable GIF: ${error.message}`);
    }
  }
  if (browserDecode === null) {
    throw new Error(`decoding ${format.toUpperCase()} needs a headless browser (Chrome, Chromium or Edge); none is available`);
  }
  const decoded = await browserDecode({ imagePath: file, width, height });
  const expected = browserDecodeSize(width, height);
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    throw new Error(`the browser decoded ${file} as ${decoded.width}x${decoded.height}, expected ${expected.width}x${expected.height}`);
  }
  assertDimensions(decoded.width, decoded.height, `the decoded ${format.toUpperCase()}`);
  return { width: decoded.width, height: decoded.height, rgba: decoded.rgba, via: 'browser', frames: 1 };
}

/**
 * Decide what to do with the background. Returns
 * { action: 'keep' | 'remove', reason, reference?, warnings: [{code, message}] }.
 */
export function chooseBackground({ mode, rgba, width, height, tolerance }) {
  if (!BACKGROUND_MODES.includes(mode)) {
    throw new Error(`--background must be one of ${BACKGROUND_MODES.join(', ')} (got "${mode}")`);
  }
  const corners = cornerPixels(rgba, width, height);
  const clear = corners.every((corner) => corner.a <= 10);
  if (mode === 'keep') return { action: 'keep', reason: 'kept as is (--background keep)', warnings: [] };
  if (mode === 'remove') {
    const reference = borderReference(rgba, width, height);
    if (reference === null) {
      return { action: 'keep', reason: 'the image border is already transparent, nothing to remove', warnings: [] };
    }
    return { action: 'remove', reason: 'removal requested (--background remove)', reference, warnings: [] };
  }
  if (clear) return { action: 'keep', reason: 'auto: the corners are already transparent', warnings: [] };
  if (cornersUniform(corners, tolerance)) {
    return {
      action: 'remove',
      reason: 'auto: the four corners are opaque and nearly the same colour, so that colour is the background',
      reference: meanColor(corners),
      warnings: [],
    };
  }
  return {
    action: 'keep',
    reason: 'auto: the corners are opaque but not one uniform colour',
    warnings: [
      {
        code: 'background-uncertain',
        message:
          'The corners are not transparent and not one uniform colour (a photo, a gradient or a patterned background?), ' +
          'so the background was kept. Try --background remove (optionally with a higher --tolerance) or supply an ' +
          'image with a transparent or plain background.',
      },
    ],
  };
}

function percent(count, total) {
  return (100 * count) / total;
}

/**
 * The measured 16 px look of a master: shrink it with the same area filter
 * the export's renderers produce and report ink, bounding box and contrast.
 */
function smallSizeMetrics(master, size) {
  const small = resizeArea(master, size, size, 16, 16);
  const analysis = analyzeRgba(16, 16, small);
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < 16 * 16; i += 1) {
    if (small[i * 4 + 3] >= 128) {
      const value = luminance(small[i * 4], small[i * 4 + 1], small[i * 4 + 2]);
      count += 1;
      sum += value;
      sumSquares += value * value;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const spread = count > 0 ? Math.sqrt(Math.max(0, sumSquares / count - mean * mean)) : 0;
  return { ink: analysis.visibleRatio, bbox: analysis.bbox, contrast: spread, opaquePixels: count };
}

/**
 * Prepare the raster master from decoded pixels: background handling, square
 * fit, measurements and honest warnings. Pure (no file access).
 */
export function prepareMaster({ decoded, background = 'auto', tolerance = DEFAULT_TOLERANCE, sourceWidth, sourceHeight }) {
  const { width, height } = decoded;
  const warnings = [];
  const total = width * height;
  const cornerAlphaBefore = cornerPixels(decoded.rgba, width, height).map((corner) => corner.a);
  let hasAlpha = false;
  for (let i = 3; i < decoded.rgba.length; i += 4) {
    if (decoded.rgba[i] < 255) {
      hasAlpha = true;
      break;
    }
  }
  const choice = chooseBackground({ mode: background, rgba: decoded.rgba, width, height, tolerance });
  warnings.push(...choice.warnings);

  let pixels = decoded.rgba;
  let transparent = 0;
  let softened = 0;
  if (choice.action === 'remove') {
    const result = removeBackground(decoded.rgba, width, height, choice.reference, tolerance);
    pixels = result.rgba;
    transparent = result.transparent;
    softened = result.softened;
    if (transparent / total > HEAVY_REMOVAL) {
      warnings.push({
        code: 'removal-heavy',
        message:
          `Background removal made ${percent(transparent, total).toFixed(1)}% of the picture transparent. ` +
          'Look at the result: a light motif on a light background, or a background that is part of the design, ' +
          'would be eaten. Lower --tolerance, use --background keep, or supply another image.',
      });
    }
  }
  const cornerAlphaAfterPicture = cornerPixels(pixels, width, height).map((corner) => corner.a);

  const fit = fitToSquare(pixels, width, height, MASTER_SIZE);
  const analysis = analyzeRgba(fit.size, fit.size, fit.rgba);
  const longestSide = Math.max(sourceWidth ?? width, sourceHeight ?? height);

  if (cornerAlphaAfterPicture.some((alpha) => alpha > 10)) {
    warnings.push({
      code: 'opaque-corners',
      message: fit.padded
        ? 'The picture itself still has opaque corners (a solid rectangle). It was centred on a transparent square, so ' +
          'the icon will look like a card; remove the background (--background remove) or use a rounded or ' +
          'transparent-cornered image.'
        : 'The corners are still opaque, so every export target will refuse this master (icons need transparent ' +
          'corners). Remove the background (--background remove) or supply a rounded or transparent-cornered image.',
    });
  }
  if (longestSide < LOW_RESOLUTION) {
    warnings.push({
      code: 'low-resolution',
      message:
        `The source is only ${longestSide} px on its longer side: sizes above ${longestSide} px (the 512 and 1024 px PNGs, the ` +
        'larger .icns and .ico entries) are enlarged and will look soft. Small sizes are unaffected.',
    });
  }
  if (analysis.bbox !== null) {
    // Both axes count: a long thin motif (65% wide, 29% tall) is mostly padding
    // although its longer side looks generous. The measure is the share of the
    // canvas AREA covered by the artwork's bounding box, compared with the
    // quarter of it that a motif spanning half of each side would cover.
    const widthShare = analysis.bbox.width / fit.size;
    const heightShare = analysis.bbox.height / fit.size;
    if (widthShare * heightShare < HEAVY_PADDING * HEAVY_PADDING) {
      warnings.push({
        code: 'heavy-padding',
        message:
          `The artwork's box spans ${Math.round(100 * widthShare)}% of the canvas width and ${Math.round(100 * heightShare)}% of its ` +
          `height (${Math.round(100 * widthShare * heightShare)}% of the area): heavy padding, possibly from a non-square source, ` +
          'so the icon will look small in its container. Crop the image to the artwork and import again.',
      });
    }
    const margin = Math.ceil(fit.size * EDGE_MARGIN);
    if (
      analysis.bbox.x < margin ||
      analysis.bbox.y < margin ||
      fit.size - (analysis.bbox.x + analysis.bbox.width) < margin ||
      fit.size - (analysis.bbox.y + analysis.bbox.height) < margin
    ) {
      warnings.push({
        code: 'touches-edge',
        message:
          'The artwork touches the edge of the image (no breathing room). Platforms that mask or add their own padding ' +
          '(macOS, Android launchers) will crop or shrink it; a few percent of margin is safer.',
      });
    }
  }
  const small = smallSizeMetrics(fit.rgba, fit.size);
  if (small.opaquePixels === 0 || small.ink < MUSH_INK || small.contrast < MUSH_CONTRAST) {
    const why =
      small.opaquePixels === 0
        ? 'nothing is visible'
        : small.ink < MUSH_INK
          ? `only ${(100 * small.ink).toFixed(1)}% of the pixels carry ink`
          : `the colour spread is only ${small.contrast.toFixed(0)} (a flat blob, the motif does not show)`;
    warnings.push({
      code: 'mush-16',
      message:
        `At 16 px the icon is probably mush: ${why}. A raster image cannot get a hand-drawn small variant. ` +
        'Options: accept it, supply a simpler image with a bolder motif, or let the icon be drawn as SVG instead.',
    });
  }

  return {
    size: fit.size,
    rgba: fit.rgba,
    png: encodePng(fit.size, fit.size, fit.rgba),
    facts: {
      sourceWidth: sourceWidth ?? width,
      sourceHeight: sourceHeight ?? height,
      decodedWidth: width,
      decodedHeight: height,
      hasAlpha,
      background: { mode: background, action: choice.action, reason: choice.reason, reference: choice.reference ?? null, tolerance },
      cornerAlphaBefore,
      cornerAlphaAfter: analysis.cornerAlphas,
      madeTransparentPercent: percent(transparent, total),
      softenedPercent: percent(softened, total),
      fit: { size: fit.size, content: fit.content, padded: fit.padded, downscaled: fit.downscaled },
      ink: { visibleRatio: analysis.visibleRatio, bbox: analysis.bbox },
      small16: small,
    },
    warnings,
  };
}

/** The wrapper SVG: the master PNG as a raster data URL on a square viewBox. */
export function wrapperSvg(png, size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">\n` +
    `<image href="data:image/png;base64,${png.toString('base64')}" x="0" y="0" width="${size}" height="${size}"/>\n` +
    '</svg>\n'
  );
}

/** Human-readable lines for the facts the tool prints. */
export function describeImport(result) {
  const lines = [];
  const f = result.facts;
  if (result.kind === 'svg') {
    lines.push(`Source: ${result.source.path} (SVG, ${result.source.bytes} bytes) - validated, copied unchanged.`);
    return lines;
  }
  lines.push(
    `Source: ${result.source.path} (${result.source.format.toUpperCase()}, ${f.sourceWidth}x${f.sourceHeight} px, ` +
      `${Math.round(result.source.bytes / 1024)} KB, ${f.hasAlpha ? 'has transparency' : 'fully opaque'}; decoded by ${result.source.via}).`,
  );
  if (result.source.frames > 1) lines.push('Animated GIF: only the first frame is used.');
  const bg = f.background;
  lines.push(
    `Background: mode ${bg.mode} -> ${bg.action}; ${bg.reason}` +
      (bg.reference ? ` (reference colour rgb(${bg.reference.r}, ${bg.reference.g}, ${bg.reference.b}), tolerance ${bg.tolerance})` : '') +
      '.',
  );
  lines.push(`Corner alpha: before [${f.cornerAlphaBefore.join(' ')}], after [${f.cornerAlphaAfter.join(' ')}].`);
  lines.push(
    `Made transparent: ${f.madeTransparentPercent.toFixed(1)}% of the pixels` +
      (f.softenedPercent > 0 ? ` (plus ${f.softenedPercent.toFixed(1)}% edge pixels made partly transparent)` : '') +
      '.',
  );
  lines.push(
    `Fit: ${f.fit.padded ? `padded to a ${f.fit.size}x${f.fit.size} square (picture ${f.fit.content.width}x${f.fit.content.height}, centred)` : `already square, ${f.fit.size}x${f.fit.size}`}` +
      `${f.fit.downscaled ? `, shrunk from ${f.sourceWidth}x${f.sourceHeight}` : ', not resized'}.`,
  );
  lines.push(
    `Artwork box on the master: ${f.ink.bbox ? `${f.ink.bbox.width}x${f.ink.bbox.height} at (${f.ink.bbox.x},${f.ink.bbox.y})` : 'none'}, ` +
      `visible ink ${(100 * f.ink.visibleRatio).toFixed(1)}%.`,
  );
  lines.push(
    `At 16 px: ink ${(100 * f.small16.ink).toFixed(1)}%, colour spread ${f.small16.contrast.toFixed(0)}, ` +
      `ink box ${f.small16.bbox ? `${f.small16.bbox.width}x${f.small16.bbox.height}` : 'none'}.`,
  );
  return lines;
}

/**
 * Import one image file into `outDir`. Writes `<name>-master.png` and
 * `<name>-master.svg` (raster input) or `<name>-master.svg` (SVG input, copied
 * after validation). Nothing is written before every check has passed, an
 * existing file is never replaced without `force`, and every write goes
 * through the same link-safe publication as the export.
 * `browserDecode({ imagePath, width, height })` is needed only for
 * JPEG/WebP/BMP (and the rare PNG the built-in codec cannot read).
 */
export async function importImage({ srcPath, outDir, name, background = 'auto', tolerance = DEFAULT_TOLERANCE, force = false, browserDecode = null }) {
  const safeName = sanitizeName(name);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_TOLERANCE) {
    throw new Error(`--tolerance must be a number from 0 to ${MAX_TOLERANCE} (got ${tolerance})`);
  }
  if (!BACKGROUND_MODES.includes(background)) {
    throw new Error(`--background must be one of ${BACKGROUND_MODES.join(', ')} (got "${background}")`);
  }
  outDir = resolveNamedPath(outDir).path;
  const source = loadSource(srcPath);
  const outputs = [];
  let result;
  if (source.format === 'svg') {
    const text = source.buffer.toString('utf8');
    const check = validateSvg(text, { label: source.path });
    if (!check.ok) throw new Error(`${source.path} cannot be used:\n  - ${check.errors.join('\n  - ')}`);
    outputs.push({ rel: `${safeName}-master.svg`, buffer: Buffer.from(text, 'utf8') });
    result = { kind: 'svg', source: { path: source.path, format: 'svg', bytes: source.buffer.length }, facts: null, warnings: [], master: null };
  } else {
    if (Math.max(source.width, source.height) < MIN_SIDE) {
      throw new Error(`${source.path} is ${source.width}x${source.height} px; an icon source must be at least ${MIN_SIDE} px on its longer side`);
    }
    const decoded = await decodeSource(source, { browserDecode });
    const prepared = prepareMaster({
      decoded,
      background,
      tolerance,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    const svg = wrapperSvg(prepared.png, prepared.size);
    const check = validateSvg(svg, { label: 'the generated wrapper' });
    if (!check.ok) throw new Error(`internal error: the generated wrapper SVG is invalid:\n  - ${check.errors.join('\n  - ')}`);
    outputs.push({ rel: `${safeName}-master.png`, buffer: prepared.png });
    outputs.push({ rel: `${safeName}-master.svg`, buffer: Buffer.from(svg, 'utf8') });
    result = {
      kind: 'raster',
      source: { path: source.path, format: source.format, bytes: source.buffer.length, via: decoded.via, frames: decoded.frames },
      facts: prepared.facts,
      warnings: prepared.warnings,
      master: { size: prepared.size },
    };
  }

  if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) throw new Error(`${outDir} exists and is not a directory`);
  if (!force) {
    const existing = outputs.filter((output) => fs.existsSync(path.join(outDir, output.rel))).map((output) => output.rel);
    if (existing.length > 0) {
      throw new Error(`${existing.map((rel) => path.join(outDir, rel)).join(', ')} already exist${existing.length === 1 ? 's' : ''}; pass --force to overwrite`);
    }
  }
  ensureRealDir(outDir, '');
  result.files = [];
  for (const output of outputs) {
    const absolute = path.join(outDir, output.rel);
    publishFile(absolute, output.buffer);
    result.files.push({ path: absolute, bytes: output.buffer.length });
  }
  return result;
}
