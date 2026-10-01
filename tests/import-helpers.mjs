// Shared builders for the import tests: synthetic images (solid canvases,
// anti-aliased rings, a healthy glyph icon, BMP and GIF writers) and temp-dir
// helpers. Nothing here touches product code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng, crc32 } from '../scripts/lib/png.mjs';
import { removeTree } from './helpers.mjs';

export const FIXTURES = path.resolve('tests/fixtures');

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-import-'));
}

export function withTemp(run) {
  const dir = tempDir();
  const done = () => removeTree(dir);
  let result;
  try {
    result = run(dir);
  } catch (error) {
    done();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(done);
  done();
  return result;
}

export const linkSkipReason = (() => {
  try {
    const dir = tempDir();
    const target = path.join(dir, 't');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'l'));
    removeTree(dir);
    return undefined;
  } catch {
    return 'this user cannot create symlinks here';
  }
})();

// ---- synthetic images -------------------------------------------------------

/** Solid RGBA canvas. */
export function canvas(width, height, [r, g, b, a]) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}

export function setPixel(rgba, width, x, y, [r, g, b, a]) {
  const o = (y * width + x) * 4;
  rgba[o] = r;
  rgba[o + 1] = g;
  rgba[o + 2] = b;
  rgba[o + 3] = a;
}

export function getPixel(rgba, width, x, y) {
  const o = (y * width + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

/**
 * A red disc with a white hole in the middle (a ring), anti-aliased against
 * `background`, on a `size` square. The hole is enclosed, so a flood fill
 * from the edges must not reach it.
 */
export function ringOnBackground(size, background) {
  const rgba = canvas(size, size, background);
  const c = (size - 1) / 2;
  const outer = size * 0.42;
  const inner = size * 0.16;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      // coverage of the red ring with a one-pixel soft edge on both sides
      const coverage = Math.max(0, Math.min(1, outer - d + 0.5)) * Math.max(0, Math.min(1, d - inner + 0.5));
      if (coverage > 0) {
        const red = [200, 30, 30];
        const mixed = red.map((value, index) => Math.round(value * coverage + background[index] * (1 - coverage)));
        setPixel(rgba, size, x, y, [mixed[0], mixed[1], mixed[2], 255]);
      }
    }
  }
  return rgba;
}

/** A healthy icon: dark rounded-looking square with a white disc, transparent corners and ~6% margin. */
export function glyphIcon(size) {
  const rgba = canvas(size, size, [0, 0, 0, 0]);
  const margin = Math.round(size * 0.06);
  const radius = Math.round(size * 0.18);
  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const dx = Math.max(margin + radius - x, 0, x - (size - margin - radius - 1));
      const dy = Math.max(margin + radius - y, 0, y - (size - margin - radius - 1));
      if (dx * dx + dy * dy <= radius * radius) setPixel(rgba, size, x, y, [30, 41, 120, 255]);
    }
  }
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x - c, y - c) < size * 0.22) setPixel(rgba, size, x, y, [250, 250, 250, 255]);
    }
  }
  return rgba;
}

export function writePng(file, width, height, rgba) {
  fs.writeFileSync(file, encodePng(width, height, rgba));
  return file;
}

/**
 * Uncompressed 24-bit BMP (bottom-up rows, BGR). `pixel(x, y)` returns the
 * [r, g, b] of the pixel at column x, row y counted from the TOP of the picture.
 */
export function makeBmp(width, height, pixel = () => [0, 0, 0]) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const buffer = Buffer.alloc(54 + rowSize * height);
  buffer.write('BM', 0, 'latin1');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const o = 54 + (height - 1 - y) * rowSize + x * 3;
      buffer[o] = b;
      buffer[o + 1] = g;
      buffer[o + 2] = r;
    }
  }
  return buffer;
}

/**
 * Minimal GIF writer: one frame, optional interlacing, optional transparent
 * index, LZW with a clear code before every symbol (valid, if not compact).
 * `indices` is row-major, width*height palette indices (palette: up to 4 colours).
 */
export function makeGif({ width, height, palette, indices, interlaced = false, transparent = -1, frames = 1, left = 0, top = 0, screenWidth = width, screenHeight = height }) {
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'latin1'));
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(screenWidth, 0);
  screen.writeUInt16LE(screenHeight, 2);
  screen[4] = 0x80 | 1; // global table of 4 colours
  parts.push(screen);
  const table = Buffer.alloc(12);
  palette.forEach(([r, g, b], i) => table.set([r, g, b], i * 3));
  parts.push(table);
  for (let frame = 0; frame < frames; frame += 1) {
    parts.push(Buffer.from([0x21, 0xf9, 4, transparent >= 0 ? 1 : 0, 2, 0, transparent >= 0 ? transparent : 0, 0]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(left, 1);
    descriptor.writeUInt16LE(top, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = interlaced ? 0x40 : 0;
    parts.push(descriptor);
    // Rows in the order they are stored.
    const order = [];
    if (interlaced) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let row = start; row < height; row += step) order.push(row);
    } else {
      for (let row = 0; row < height; row += 1) order.push(row);
    }
    // 2-bit codes + 1 = 3-bit code size; clear = 4, end = 5.
    const bits = [];
    const put = (code) => {
      for (let i = 0; i < 3; i += 1) bits.push((code >> i) & 1);
    };
    for (const row of order) {
      for (let column = 0; column < width; column += 1) {
        put(4);
        put(indices[row * width + column]);
      }
    }
    put(4);
    put(5);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8 && i + j < bits.length; j += 1) value |= bits[i + j] << j;
      bytes.push(value);
    }
    parts.push(Buffer.from([2]));
    for (let i = 0; i < bytes.length; i += 255) {
      const slice = bytes.slice(i, i + 255);
      parts.push(Buffer.from([slice.length, ...slice]));
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}


/** A valid 16-bit RGBA PNG filled with one colour (the built-in codec only reads 8-bit PNGs). */
export function makePng16(width, height, [r, g, b, a]) {
  const row = Buffer.alloc(1 + width * 8);
  for (let x = 0; x < width; x += 1) {
    [r, g, b, a].forEach((value, channel) => row.writeUInt16BE(value * 257, 1 + x * 8 + channel * 2));
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
