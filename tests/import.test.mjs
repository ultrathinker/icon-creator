// Tests for reading the user's image file: format detection by content, size
// and pixel caps, safe paths and the built-in GIF decoder. Images are built
// from synthetic pixels or come from the few-KB fixtures in tests/fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePng } from '../scripts/lib/png.mjs';
import {
  detectFormat,
  headerDimensions,
  loadSource,
  decodeGifFirstFrame,
  MAX_INPUT_BYTES,
  MAX_SIDE,
} from '../scripts/lib/imagefile.mjs';
import {
  FIXTURES,
  withTemp,
  linkSkipReason,
  canvas,
  setPixel,
  getPixel,
  glyphIcon,
  writePng,
  makeBmp,
  makeGif,
} from './import-helpers.mjs';

// ---- detection, headers, caps ------------------------------------------------

test('the format comes from the content, never from the file extension', () => {
  withTemp((dir) => {
    const png = encodePng(4, 4, canvas(4, 4, [10, 20, 30, 255]));
    const jpegBytes = fs.readFileSync(path.join(FIXTURES, 'import-white.jpg'));
    const disguised = [
      ['picture.jpg', png, 'png'],
      ['photo.png', jpegBytes, 'jpeg'],
      ['anim.webp', fs.readFileSync(path.join(FIXTURES, 'import-anim.gif')), 'gif'],
      ['clock.gif', fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp')), 'webp'],
      ['plain.bmp', makeBmp(5, 3), 'bmp'],
      ['vector.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>'), 'svg'],
      ['bom.svg', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  \n<?xml version="1.0"?><svg/>')]), 'svg'],
    ];
    for (const [name, bytes, expected] of disguised) {
      assert.equal(detectFormat(bytes), expected, `${name} is ${expected}`);
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      if (expected !== 'svg') assert.equal(loadSource(file).format, expected, `loadSource(${name})`);
    }
    // Text that is not an image, with an image extension, is refused.
    const notImage = path.join(dir, 'notes.png');
    fs.writeFileSync(notImage, 'just some words');
    assert.equal(detectFormat(Buffer.from('just some words')), null);
    assert.throws(() => loadSource(notImage), /not a supported image: its content is not PNG, JPEG, WebP, GIF, BMP or SVG/);
    // Binary junk that happens to start with "<" is not SVG either.
    assert.equal(detectFormat(Buffer.from([0x3c, 0x00, 0x01, 0x02])), null);
  });
});

test('dimensions are read from the header of every format without decoding', () => {
  assert.deepEqual(headerDimensions(encodePng(7, 5, canvas(7, 5, [0, 0, 0, 255])), 'png'), { width: 7, height: 5 });
  assert.deepEqual(headerDimensions(fs.readFileSync(path.join(FIXTURES, 'import-white.jpg')), 'jpeg'), { width: 96, height: 96 });
  assert.deepEqual(headerDimensions(fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp')), 'webp'), { width: 96, height: 96 });
  assert.deepEqual(headerDimensions(fs.readFileSync(path.join(FIXTURES, 'import-anim.gif')), 'gif'), { width: 32, height: 32 });
  assert.deepEqual(headerDimensions(makeBmp(13, 9), 'bmp'), { width: 13, height: 9 });
});

test('the pixel cap is applied from the header, before any decoding', () => {
  withTemp((dir) => {
    // A 60-byte file whose IHDR claims a huge image: refused without trying to decode it.
    const bomb = encodePng(1, 1, canvas(1, 1, [0, 0, 0, 255]));
    bomb.writeUInt32BE(MAX_SIDE + 1, 16);
    bomb.writeUInt32BE(10, 20);
    const file = path.join(dir, 'bomb.png');
    fs.writeFileSync(file, bomb);
    assert.throws(() => loadSource(file), new RegExp(`is ${MAX_SIDE + 1}x10 px; the limit is ${MAX_SIDE}x${MAX_SIDE}`));
    // The same for a JPEG whose frame header is patched to a huge height.
    const jpeg = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'import-white.jpg')));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(sof > 0, 'fixture has a baseline frame header');
    jpeg.writeUInt16BE(20000, sof + 5);
    const jpegFile = path.join(dir, 'tall.jpg');
    fs.writeFileSync(jpegFile, jpeg);
    assert.throws(() => loadSource(jpegFile), /the limit is 8192x8192/);
    // The limit itself is allowed.
    const edge = encodePng(1, 1, canvas(1, 1, [0, 0, 0, 255]));
    edge.writeUInt32BE(MAX_SIDE, 16);
    edge.writeUInt32BE(MAX_SIDE, 20);
    const edgeFile = path.join(dir, 'edge.png');
    fs.writeFileSync(edgeFile, edge);
    assert.equal(loadSource(edgeFile).width, MAX_SIDE);
  });
});

test('the byte cap refuses an oversized file and an empty one', () => {
  withTemp((dir) => {
    const big = path.join(dir, 'big.png');
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    encodePng(1, 1, canvas(1, 1, [0, 0, 0, 255])).copy(bytes);
    fs.writeFileSync(big, bytes);
    assert.throws(() => loadSource(big), /the limit is 25 MB/);
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, '');
    assert.throws(() => loadSource(empty), /is empty/);
  });
});

test('directories, missing files and links are refused', { skip: undefined }, () => {
  withTemp((dir) => {
    assert.throws(() => loadSource(dir), /not a regular file/);
    assert.throws(() => loadSource(path.join(dir, 'nope.png')), /no such file/);
  });
});

test('a symbolic link to the image is refused', { skip: linkSkipReason }, () => {
  withTemp((dir) => {
    const real = writePng(path.join(dir, 'real.png'), 4, 4, canvas(4, 4, [1, 2, 3, 255]));
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(real, link);
    assert.throws(() => loadSource(link), /is a symbolic link: refusing to follow it/);
  });
});

test('a symbolic link or junction anywhere in the directory chain is refused', { skip: linkSkipReason }, () => {
  withTemp((dir) => {
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    writePng(path.join(realDir, 'x.png'), 4, 4, canvas(4, 4, [1, 2, 3, 255]));
    const linked = path.join(dir, 'linked');
    fs.symlinkSync(realDir, linked, 'junction');
    assert.throws(() => loadSource(path.join(linked, 'x.png')), /symbolic link or junction/);
    assert.equal(loadSource(path.join(realDir, 'x.png')).format, 'png');
  });
});

// ---- the built-in GIF decoder ------------------------------------------------

const GIF_PALETTE = [[255, 0, 255], [220, 30, 30], [30, 30, 220], [0, 200, 0]];

test('the GIF decoder returns the first frame, honouring transparency and animation', () => {
  const first = decodeGifFirstFrame(fs.readFileSync(path.join(FIXTURES, 'import-anim.gif')));
  assert.equal(first.frames, 2, 'a second frame follows and is ignored');
  assert.deepEqual([first.width, first.height], [32, 32]);
  assert.deepEqual(getPixel(first.rgba, 32, 0, 0).slice(3), [0], 'the transparent index stays transparent');
  assert.deepEqual(getPixel(first.rgba, 32, 16, 16), [220, 30, 30, 255], 'frame 1 is red; frame 2 would be blue');
});

test('the GIF decoder reads interlaced frames and frames smaller than the screen', () => {
  const width = 3;
  const height = 9;
  const indices = Array.from({ length: width * height }, (_, i) => 1 + (Math.floor(i / width) % 3));
  for (const interlaced of [false, true]) {
    const gif = makeGif({ width, height, palette: GIF_PALETTE, indices, interlaced });
    const { rgba, frames } = decodeGifFirstFrame(gif);
    assert.equal(frames, 1);
    for (let y = 0; y < height; y += 1) {
      const expected = [...GIF_PALETTE[1 + (y % 3)], 255];
      assert.deepEqual(getPixel(rgba, width, 1, y), expected, `row ${y} (interlaced: ${interlaced})`);
    }
  }
  // A 2x2 frame at (3,1) on a 6x5 screen: everything else stays transparent.
  const small = makeGif({ width: 2, height: 2, palette: GIF_PALETTE, indices: [3, 3, 3, 3], left: 3, top: 1, screenWidth: 6, screenHeight: 5 });
  const placed = decodeGifFirstFrame(small);
  assert.deepEqual(getPixel(placed.rgba, 6, 3, 1), [0, 200, 0, 255]);
  assert.deepEqual(getPixel(placed.rgba, 6, 4, 2), [0, 200, 0, 255]);
  assert.equal(getPixel(placed.rgba, 6, 0, 0)[3], 0);
  assert.equal(getPixel(placed.rgba, 6, 5, 4)[3], 0);
});

test('a truncated or corrupt GIF is an error, not garbage', () => {
  const gif = fs.readFileSync(path.join(FIXTURES, 'import-anim.gif'));
  assert.throws(() => decodeGifFirstFrame(gif.subarray(0, 40)), /truncated|no image data/);
  // An unknown block type right after the 4-colour global table (13 + 12 bytes in).
  const corrupt = makeGif({ width: 2, height: 2, palette: GIF_PALETTE, indices: [1, 1, 1, 1] });
  corrupt[25] = 0x99;
  assert.throws(() => decodeGifFirstFrame(corrupt), /malformed/);
});
