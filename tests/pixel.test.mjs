// Tests of the pixel foundation: PNG codec round-trips, ICO and ICNS writers
// and parsers, background removal / resize / fit, and image header validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng, decodePng, pngInfo, analyzeRgba } from '../scripts/lib/png.mjs';
import { buildIco, parseIco } from '../scripts/lib/ico.mjs';
import { buildIcns, parseIcns, ICNS_PNG_TYPES } from '../scripts/lib/icns.mjs';
import { removeBackground, resizeArea, fitToSquare, cornerPixels, cornersUniform, borderReference } from '../scripts/lib/pixels.mjs';
import { detectFormat, headerDimensions, assertDimensions } from '../scripts/lib/imagefile.mjs';
import {
  candidateTile, candidateNoisy, candidateGradient, candidateRinging, candidateTransparent,
  tinyJpegBytes, tinyWebpBytes, pngOf, canvas, fillCircle, decodeToSize, getPixel,
} from './pixel-helpers.mjs';

test('png encode/decode round-trips every synthetic candidate', () => {
  for (const candidate of [
    candidateTile(512),
    candidateNoisy(256),
    candidateGradient(256),
    candidateRinging(256),
    candidateTransparent(256),
  ]) {
    const decoded = decodePng(candidate);
    assert.equal(decoded.width, decoded.height);
    assert.equal(decoded.rgba.length, decoded.width * decoded.height * 4);
    const roundTrip = encodePng(decoded.width, decoded.height, decoded.rgba);
    assert.deepEqual(pngInfo(roundTrip), { ...pngInfo(candidate) });
  }
});

test('png decoder refuses truncated and corrupt files', () => {
  const good = candidateTile(128);
  assert.throws(() => decodePng(good.subarray(0, good.length - 20)), /IEND|truncated|CRC/);
  const corrupted = Buffer.from(good);
  corrupted[60] ^= 0xff;
  assert.throws(() => decodePng(corrupted), /CRC|corrupt/);
});

test('analyzeRgba sees the subject box and transparent corners', () => {
  const { rgba, size } = decodeToSize(candidateTransparent(128));
  const analysis = analyzeRgba(size, size, rgba);
  assert.ok(analysis.cornerAlphas.every((alpha) => alpha === 0));
  assert.ok(analysis.visibleRatio > 0.3 && analysis.visibleRatio < 0.7);
  assert.ok(analysis.bbox.width > size * 0.5);
});

test('background removal keeps enclosed light areas and clears the border', () => {
  const { rgba, size } = decodeToSize(candidateTile(256));
  const corners = cornerPixels(rgba, size, size);
  assert.ok(cornersUniform(corners, 32));
  const reference = borderReference(rgba, size, size);
  assert.deepEqual(reference, { r: 255, g: 255, b: 255 });
  const result = removeBackground(rgba, size, size, reference, 32);
  const after = cornerPixels(result.rgba, size, size);
  assert.ok(after.every((corner) => corner.a === 0), 'corners must be transparent');
  assert.ok(result.transparent > size * size * 0.2, 'a real share of the picture is background');
  // The enclosed white window inside the tile survives.
  const center = getPixel(result.rgba, size, Math.floor(size / 2), Math.floor(size / 2));
  assert.equal(center[3], 255);
});

test('background removal tolerates a noisy background', () => {
  const { rgba, size } = decodeToSize(candidateNoisy(192));
  const reference = borderReference(rgba, size, size);
  const result = removeBackground(rgba, size, size, reference, 32);
  const after = cornerPixels(result.rgba, size, size);
  assert.ok(after.every((corner) => corner.a === 0));
  // The subject core stays opaque.
  const core = getPixel(result.rgba, size, Math.floor(size / 2), Math.floor(size * 0.75));
  assert.equal(core[3], 255);
});

test('resizeArea shrinks without letting the background bleed into edges', () => {
  const { rgba, size } = decodeToSize(candidateTile(256));
  const reference = borderReference(rgba, size, size);
  const removed = removeBackground(rgba, size, size, reference, 32).rgba;
  const small = resizeArea(removed, size, size, 16, 16);
  // The corners stay fully transparent; the center (enclosed window) stays visible.
  assert.equal(small[3], 0);
  assert.equal(small[(8 * 16 + 8) * 4 + 3], 255);
});

test('fitToSquare pads a non-square picture and never enlarges', () => {
  const wide = canvas(64);
  fillCircle(wide, 64, 32, 32, 30, [10, 20, 30, 255]);
  const fit = fitToSquare(wide, 64, 40, 512);
  assert.equal(fit.size, 64, 'a picture smaller than the max is not enlarged');
  assert.equal(fit.padded, true);
  assert.ok(fit.content.height <= 40);
});

test('ico writer and parser agree on every size', () => {
  const entries = [16, 32, 48, 256].map((size) => {
    const rgba = canvas(size, [200, 30, 30, 255]);
    return { size, png: encodePng(size, size, rgba) };
  });
  const ico = buildIco(entries);
  const parsed = parseIco(ico);
  assert.equal(parsed.count, 4);
  assert.deepEqual(parsed.entries.map((entry) => entry.declaredWidth), [16, 32, 48, 256]);
  assert.ok(parsed.entries.every((entry) => entry.isPng));
  assert.throws(() => buildIco([{ size: 32, png: entries[0].png }]), /claims 32px/);
});

test('icns writer and parser agree, and missing sizes are refused', () => {
  const bySize = new Map(
    [...new Set(ICNS_PNG_TYPES.map((entry) => entry.size))].map((size) => {
      const rgba = canvas(size, [30, 30, 200, 255]);
      return [size, encodePng(size, size, rgba)];
    }),
  );
  const icns = buildIcns(bySize);
  const parsed = parseIcns(icns);
  assert.equal(parsed.chunks.length, ICNS_PNG_TYPES.length);
  assert.ok(parsed.chunks.every((chunk) => chunk.pngSize.width === chunk.expectedSize));
  // A partial set is allowed (a 512 px master has no 1024 px slice): that slice just gets no chunk.
  bySize.delete(1024);
  const partial = parseIcns(buildIcns(bySize));
  assert.equal(partial.chunks.length, ICNS_PNG_TYPES.length - 1);
  assert.ok(!partial.chunks.some((chunk) => chunk.type === 'ic10'));
  // But not an empty set, nothing below 256 px, and not a size that has no slice.
  assert.throws(() => buildIcns(new Map()), /up to at least 256/);
  assert.throws(() => buildIcns(new Map([[16, bySize.get(16)], [32, bySize.get(32)]])), /up to at least 256/);
  assert.throws(() => buildIcns(new Map([[256, bySize.get(256)], [100, bySize.get(64)]])), /no slice of 100/);
});

/** What the candidate pipeline reads from a picture's header before decoding it. */
function headerOf(buffer) {
  const format = detectFormat(buffer);
  if (format === null) throw new Error('not a PNG, JPEG, GIF, WebP or BMP picture');
  const { width, height } = headerDimensions(buffer, format);
  assertDimensions(width, height);
  return { format, width, height };
}

test('image header reading accepts png, jpeg and webp with sane sizes', () => {
  assert.deepEqual(headerOf(candidateTile(512)), { format: 'png', width: 512, height: 512 });
  assert.deepEqual(headerOf(tinyJpegBytes(512, 384)), { format: 'jpeg', width: 512, height: 384 });
  assert.deepEqual(headerOf(tinyWebpBytes(512, 512)), { format: 'webp', width: 512, height: 512 });
});

test('image header reading refuses junk, empty and oversized images', () => {
  assert.throws(() => headerOf(Buffer.from('not an image at all, really')), /not a PNG/);
  assert.throws(() => headerOf(tinyWebpBytes(9000, 9000)), /the limit is 8192x8192/);
  assert.throws(() => headerOf(Buffer.alloc(0)), /not a PNG/);
});
