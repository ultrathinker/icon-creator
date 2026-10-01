// Corrupt and truncated input: a file whose header looks fine but whose body is
// damaged must be refused, never turned into a blank or garbled master. Every
// case here was found by the round-12 review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodePng, decodePng } from '../scripts/lib/png.mjs';
import { loadSource, decodeGifFirstFrame, assertComplete } from '../scripts/lib/imagefile.mjs';
import { prepareMaster } from '../scripts/lib/importimg.mjs';
import { decodePageHtml, discoverRenderers } from '../scripts/lib/renderers.mjs';
import { FIXTURES, withTemp, canvas, setPixel, glyphIcon, makeBmp, makeGif } from './import-helpers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const browserSkip = discovery.chosen !== null && discovery.chosen.kind === 'browser' ? undefined : 'no headless browser on this machine';

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 900000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const jpegFixture = () => fs.readFileSync(path.join(FIXTURES, 'import-white.jpg'));
const webpFixture = () => fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp'));

// ---- PNG chunk checksums ----------------------------------------------------

/** The byte offset of the CRC field of the first chunk of this type. */
function crcOffset(png, type) {
  const at = png.indexOf(Buffer.from(type, 'latin1'));
  return at + 4 + png.readUInt32BE(at - 4);
}

test('a PNG chunk with a wrong CRC is refused, critical or not', () => {
  const good = encodePng(8, 8, canvas(8, 8, [10, 20, 30, 255]));
  assert.equal(decodePng(good).width, 8, 'the intact file decodes');

  const badIdat = Buffer.from(good);
  badIdat[crcOffset(badIdat, 'IDAT')] ^= 0xff;
  assert.throws(() => decodePng(badIdat), /chunk IDAT fails its CRC check/);

  const badHeader = Buffer.from(good);
  badHeader[crcOffset(badHeader, 'IHDR')] ^= 0x01;
  assert.throws(() => decodePng(badHeader), /chunk IHDR fails its CRC check/);

  // An ancillary chunk (here a text chunk with a wrong CRC) counts too.
  const text = Buffer.from('Comment\0hello', 'latin1');
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  text.copy(chunk, 8);
  chunk.writeUInt32BE(0xdeadbeef, 8 + text.length); // wrong on purpose
  const iend = good.indexOf(Buffer.from('IEND', 'latin1')) - 4;
  const withBadText = Buffer.concat([good.subarray(0, iend), chunk, good.subarray(iend)]);
  assert.throws(() => decodePng(withBadText), /chunk tEXt fails its CRC check/);
});

test('import refuses a PNG with a damaged chunk and writes nothing', () => {
  withTemp((dir) => {
    const png = encodePng(40, 40, glyphIcon(40));
    png[crcOffset(png, 'IDAT')] ^= 0xff;
    const file = path.join(dir, 'bad-crc.png');
    fs.writeFileSync(file, png);
    const out = path.join(dir, 'out');
    const { code, stderr } = runCli(['import', file, '--out', out, '--name', 'bad']);
    assert.equal(code, 1);
    assert.match(stderr, /is not a readable PNG: PNG chunk IDAT fails its CRC check/);
    assert.equal(fs.existsSync(out), false);
  });
});

// ---- GIF streams that end early -------------------------------------------

/** A structurally complete 16x16 GIF whose compressed data is exactly `codeBytes`. */
function gifWithData(codeBytes) {
  const header = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([16, 0, 16, 0, 0x81, 0, 0]),
    Buffer.from([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 16, 0, 16, 0, 0]),
    Buffer.from([2, codeBytes.length, ...codeBytes, 0, 0x3b]),
  ]);
  return header;
}

test('a GIF whose LZW data stops early is corrupt, not a transparent image', () => {
  // Only the clear code (4, three bits): the data ends with no pixel and no end code.
  assert.throws(() => decodeGifFirstFrame(gifWithData([0x04])), /ends before all pixels were decoded/);
  // Clear code, one pixel, then the end code (5): the end code arrives 255 pixels too early.
  // codes 4, 1, 5 packed LSB first, three bits each: byte 0 = 0b01001100, byte 1 = 0b00000001.
  const early = gifWithData([0b01001100, 0b00000001]);
  assert.throws(() => decodeGifFirstFrame(early), /ends before all pixels were decoded/);
  // The writer used by the other tests still produces valid streams.
  const ok = makeGif({ width: 4, height: 4, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]], indices: Array(16).fill(1) });
  assert.equal(decodeGifFirstFrame(ok).frames, 1);
});

test('import refuses an early-terminated GIF and writes nothing', () => {
  withTemp((dir) => {
    const file = path.join(dir, 'early.gif');
    fs.writeFileSync(file, gifWithData([0x04]));
    const out = path.join(dir, 'out');
    const { code, stderr } = runCli(['import', file, '--out', out, '--name', 'early']);
    assert.equal(code, 1);
    assert.match(stderr, /is not a readable GIF: the GIF image data ends before all pixels were decoded/);
    assert.equal(fs.existsSync(out), false);
  });
});

// ---- truncated JPEG, WebP and BMP -----------------------------------------

test('truncated JPEG, WebP and BMP files are refused from their structure', () => {
  withTemp((dir) => {
    const bmp = makeBmp(64, 64, () => [200, 50, 50]);
    const cases = [
      ['early.jpg', jpegFixture().subarray(0, 700), /JPEG is truncated or corrupt/],
      ['late.jpg', jpegFixture().subarray(0, -60), /JPEG is truncated or corrupt/],
      ['early.webp', webpFixture().subarray(0, 90), /WebP is truncated \(its header declares 232 bytes, the file has 90\)/],
      ['late.webp', webpFixture().subarray(0, -20), /WebP is truncated/],
      ['rows.bmp', bmp.subarray(0, 54 + 4 * 192), /BMP is truncated \(the pixel rows run past the end/],
      ['nodata.bmp', bmp.subarray(0, 54), /BMP is truncated/],
    ];
    for (const [name, bytes, pattern] of cases) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      assert.throws(() => loadSource(file), pattern, name);
    }
    // The intact originals pass the same checks.
    for (const [name, bytes] of [['ok.jpg', jpegFixture()], ['ok.webp', webpFixture()], ['ok.bmp', bmp]]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      assert.ok(loadSource(file).width > 0, name);
    }
    // Trailing bytes after a complete JPEG (padding, a second picture) are fine.
    assert.doesNotThrow(() => assertComplete(Buffer.concat([jpegFixture(), Buffer.alloc(16)]), 'jpeg'));
  });
});

test('import refuses truncated files of every browser-decoded format and writes nothing', () => {
  withTemp((dir) => {
    for (const [name, bytes] of [
      ['t.jpg', jpegFixture().subarray(0, 700)],
      ['t.webp', webpFixture().subarray(0, 90)],
      ['t.bmp', makeBmp(64, 64, () => [1, 2, 3]).subarray(0, 54 + 4 * 192)],
    ]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      const out = path.join(dir, `out-${name}`);
      const { code, stderr } = runCli(['import', file, '--out', out, '--name', 'bad']);
      assert.equal(code, 1, `${name}: ${stderr}`);
      assert.match(stderr, /truncated/);
      assert.equal(fs.existsSync(out), false, `${name} created output`);
    }
  });
});

// ---- the browser's own verdict ----------------------------------------------

test('the decode page carries the load verdict in a row of its own and nothing else dynamic', () => {
  const html = decodePageHtml('file:///x/y.jpg', 96, 80);
  assert.match(html, /<img id="picture" src="file:\/\/\/x\/y\.jpg" style="width:96px;height:80px">/);
  assert.match(html, /#verdict\{position:absolute;left:0;top:80px;width:96px;height:1px;background:rgb\(255,0,255\)\}/, 'magenta by default (fail-safe)');
  assert.match(html, /naturalWidth > 0/);
  assert.match(html, /rgb\(0,255,0\)/);
  assert.ok(!/https?:|fetch|XMLHttpRequest|import\(|eval/.test(html), 'the page script touches no network');
});

test('a JPEG the browser cannot decode is refused even though its header and end marker look fine', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const jpeg = Buffer.from(jpegFixture());
    const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    jpeg[frame + 9] = 7; // seven colour components: a frame header no decoder accepts
    const file = path.join(dir, 'bad-frame.jpg');
    fs.writeFileSync(file, jpeg);
    const out = path.join(dir, 'out');
    const { code, stderr } = runCli(['import', file, '--out', out, '--name', 'bad']);
    assert.equal(code, 1);
    assert.match(stderr, /the browser could not decode bad-frame\.jpg: the file is corrupt, truncated/);
    assert.equal(fs.existsSync(out), false);
    // The intact fixture still imports through the same path.
    const good = runCli(['import', path.join(FIXTURES, 'import-white.jpg'), '--out', path.join(dir, 'good'), '--name', 'ok']);
    assert.equal(good.code, 0, good.stderr);
  });
});

// ---- heavy padding on both axes ------------------------------------------------

test('a long thin motif on a non-square picture is flagged as heavy padding', () => {
  // 1200x700 white picture, a 667x292 dark motif in the middle: the longer side
  // looks generous (65%) but the box covers only about 14% of the canvas.
  const width = 1200;
  const height = 700;
  const rgba = canvas(width, height, [255, 255, 255, 255]);
  for (let y = 204; y < 204 + 292; y += 1) for (let x = 266; x < 266 + 667; x += 1) setPixel(rgba, width, x, y, [30, 60, 160, 255]);
  const master = prepareMaster({ decoded: { width, height, rgba }, sourceWidth: width, sourceHeight: height });
  const warning = master.warnings.find((w) => w.code === 'heavy-padding');
  assert.ok(warning, 'heavy-padding is reported');
  assert.match(warning.message, /spans 56% of the canvas width and 25% of its height \(14% of the area\)/);
});

test('padding is judged by area: a motif of at least half the width and height is fine', () => {
  const size = 600;
  const half = canvas(size, size, [0, 0, 0, 0]);
  for (let y = 150; y < 450; y += 1) for (let x = 150; x < 450; x += 1) setPixel(half, size, x, y, [200, 30, 30, 255]);
  const codes = prepareMaster({ decoded: { width: size, height: size, rgba: half } }).warnings.map((w) => w.code);
  assert.ok(!codes.includes('heavy-padding'), 'exactly half of each side is the boundary and passes');
  const slim = canvas(size, size, [0, 0, 0, 0]);
  for (let y = 100; y < 500; y += 1) for (let x = 250; x < 350; x += 1) setPixel(slim, size, x, y, [200, 30, 30, 255]); // 17% wide, 67% tall
  assert.ok(prepareMaster({ decoded: { width: size, height: size, rgba: slim } }).warnings.some((w) => w.code === 'heavy-padding'));
});
