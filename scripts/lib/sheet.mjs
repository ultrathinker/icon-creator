// Contact sheets: one PNG that shows several SVG concepts at several sizes
// on a light and a dark background, so a reviewer (human or model) can judge
// silhouette, contrast and small-size legibility in a single image.
//
// The sheet is composed locally from per-size renders (each cell is produced
// by the same renderer pipeline `render` uses, at the cell's exact pixel
// size, then alpha-blended onto the background). This works identically for
// browser and command-line renderers - no browser-specific screenshot flags
// are involved.

import fs from 'node:fs';
import path from 'node:path';
import { validateSvg } from './svgcheck.mjs';
import { encodePng, decodePng } from './png.mjs';
import { assertRealParentChain, publishExclusive } from './publish.mjs';
import { renderSvgPng } from './renderers.mjs';

export const DEFAULT_SHEET_SIZES = [256, 64, 32, 16];
export const DEFAULT_CHECK_SIZES = [48, 32, 16];
export const SHEET_CELL = 288;
export const SHEET_CELL_PAD = 16;
export const SHEET_DIVIDER = 8;
export const SHEET_BACKGROUNDS = ['#ffffff', '#101216'];

function colorToRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** Alpha-blend `icon` onto the opaque canvas at (x0, y0). */
function blit(canvas, canvasWidth, x0, y0, icon) {
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const source = (y * icon.width + x) * 4;
      const alpha = icon.rgba[source + 3] / 255;
      const destination = ((y0 + y) * canvasWidth + (x0 + x)) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const background = canvas[destination + channel];
        const foreground = icon.rgba[source + channel];
        canvas[destination + channel] = Math.round(foreground * alpha + background * (1 - alpha));
      }
      canvas[destination + 3] = 255;
    }
  }
}

/**
 * Compose the sheet: one block per background; inside a block one row per
 * size (largest first as given), one cell per SVG, left to right in argument
 * order. Returns the exact canvas dimensions.
 */
export function composeSheet({ iconsByCell, sizes, backgrounds = SHEET_BACKGROUNDS, cell = SHEET_CELL, divider = SHEET_DIVIDER }) {
  const conceptCount = iconsByCell.length;
  const width = conceptCount * cell;
  const height = backgrounds.length * sizes.length * cell + divider * (backgrounds.length - 1);
  const canvas = Buffer.alloc(width * height * 4);
  const paintRows = (from, to, [red, green, blue]) => {
    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        canvas[offset] = red;
        canvas[offset + 1] = green;
        canvas[offset + 2] = blue;
        canvas[offset + 3] = 255;
      }
    }
  };
  // The whole canvas starts as the divider grey; each block paints over its
  // own rows, leaving a visible neutral seam between the light and dark
  // halves.
  paintRows(0, height, colorToRgb('#9aa0a6'));
  backgrounds.forEach((background, blockIndex) => {
    const blockTop = blockIndex * (sizes.length * cell + divider);
    paintRows(blockTop, blockTop + sizes.length * cell, colorToRgb(background));
    sizes.forEach((size, rowIndex) => {
      iconsByCell.forEach((icons, columnIndex) => {
        const icon = icons.get(size);
        if (!icon) return;
        blit(
          canvas,
          width,
          columnIndex * cell + Math.floor((cell - icon.width) / 2),
          blockTop + rowIndex * cell + Math.floor((cell - icon.height) / 2),
          icon,
        );
      });
    });
  });
  return { canvas, width, height };
}

/**
 * Render every concept at every size, compose the sheet and publish it
 * exclusively at `outPath`. `render(svgPath, size, outPath)` is injectable
 * for tests; the default goes through the real renderer pipeline, which
 * handles both browser and command-line renderers. Cells always fit the
 * largest requested size (never less than the default 288 px), so no render
 * is ever cropped to fit its cell.
 */
export async function renderSheet({ svgPaths, outPath, renderer, tempDir, sizes, backgrounds = SHEET_BACKGROUNDS, cell = SHEET_CELL, divider = SHEET_DIVIDER, force = false, render = null, log = () => {} }) {
  if (!force && fs.existsSync(outPath)) {
    throw new Error(`${outPath} already exists; pass --force to overwrite it`);
  }
  let outStat = null;
  try {
    outStat = fs.lstatSync(outPath);
  } catch {
    outStat = null;
  }
  if (outStat !== null && outStat.isSymbolicLink()) {
    throw new Error(`${outPath} is a symbolic link: refusing to write through it`);
  }
  assertRealParentChain(outPath);
  for (const svgPath of svgPaths) {
    const validation = validateSvg(fs.readFileSync(svgPath, 'utf8'), { label: svgPath });
    if (!validation.ok) {
      throw new Error(`${svgPath} cannot be rendered:\n  - ${validation.errors.join('\n  - ')}`);
    }
  }
  const renderCell =
    render ??
    ((svgPath, size, outPath) => renderSvgPng({ svgPath, size, outPath, renderer, tempDir, log }));

  const iconsByCell = [];
  let scratchCount = 0;
  for (const svgPath of svgPaths) {
    const bySize = new Map();
    for (const size of sizes) {
      const scratch = path.join(tempDir, `cell-${scratchCount += 1}-${size}.png`);
      await renderCell(svgPath, size, scratch);
      bySize.set(size, decodePng(fs.readFileSync(scratch)));
      fs.rmSync(scratch, { force: true });
    }
    iconsByCell.push(bySize);
  }
  // A cell must hold the largest requested render plus padding, so an
  // oversized --sizes value can never be silently cropped.
  const cellSize = Math.max(cell, Math.max(...sizes) + 2 * SHEET_CELL_PAD);
  const { canvas, width, height } = composeSheet({ iconsByCell, sizes, backgrounds, cell: cellSize, divider });
  publishExclusive(outPath, encodePng(width, height, canvas));
  return { width, height };
}
