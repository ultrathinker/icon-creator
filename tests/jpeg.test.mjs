// The bundled baseline JPEG decoder, compared with libjpeg (via Pillow) on small fixtures, plus the refusals that
// send a file to the browser (or skip it) instead of guessing. Offline: every input is embedded in jpeg-fixtures.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJpeg } from '../scripts/lib/jpeg.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { DECODABLE, PROGRESSIVE_JPEG, CMYK_JPEG, SQUARE_420_JPEG, ADOBE_RGB_JPEG, ID_RGB_JPEG } from './jpeg-fixtures.mjs';

const bytes = (base64) => Buffer.from(base64, 'base64');

/** Mean and maximum absolute difference per channel between our decode and libjpeg's picture. */
function difference(fixture) {
  const ours = decodeJpeg(bytes(fixture.jpeg));
  const reference = decodePng(bytes(fixture.reference));
  assert.equal(ours.width, fixture.width);
  assert.equal(ours.height, fixture.height);
  assert.equal(reference.width, fixture.width);
  assert.equal(reference.height, fixture.height);
  let sum = 0;
  let max = 0;
  const pixels = fixture.width * fixture.height;
  for (let i = 0; i < pixels; i += 1) {
    assert.equal(ours.rgba[i * 4 + 3], 255, 'a JPEG has no transparency');
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(ours.rgba[i * 4 + channel] - reference.rgba[i * 4 + channel]);
      sum += delta;
      if (delta > max) max = delta;
    }
  }
  return { mean: sum / (pixels * 3), max };
}

for (const [name, fixture] of Object.entries(DECODABLE)) {
  test(`jpeg decoder matches libjpeg: ${name}`, () => {
    const { mean, max } = difference(fixture);
    // Measured on the machine that made the fixtures: mean 0.2-0.4, max 3. The bounds leave room for rounding only.
    assert.ok(mean < 1, `mean difference ${mean.toFixed(2)}`);
    assert.ok(max <= 6, `max difference ${max}`);
  });
}

test('progressive and CMYK JPEGs are refused with a clear reason', () => {
  assert.throws(() => decodeJpeg(bytes(PROGRESSIVE_JPEG)), /progressive/);
  assert.throws(() => decodeJpeg(bytes(CMYK_JPEG)), /4 components/);
});

test('broken inputs are refused, never guessed at', () => {
  const full = bytes(DECODABLE.ycc420Odd.jpeg);
  assert.throws(() => decodeJpeg(Buffer.from('not a jpeg at all')), /not a JPEG/);
  assert.throws(() => decodeJpeg(full.subarray(0, 2)), /no frame header|not a JPEG/);
  assert.throws(() => decodeJpeg(full.subarray(0, Math.floor(full.length * 0.6))), /entropy data|truncated|ends early/);
  // The header ends right after the scan header: no entropy data at all.
  const scanAt = full.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scanAt > 0);
  assert.throws(() => decodeJpeg(full.subarray(0, scanAt + 2 + 2 + 1 + 6 + 3)), /entropy data|truncated|ends early|no scan/);
});

test('an expected restart marker that is missing is an error', () => {
  const restart = Buffer.from(bytes(DECODABLE.ycc444Restart.jpeg));
  const at = restart.indexOf(Buffer.from([0xff, 0xd0]));
  assert.ok(at > 0, 'the fixture really has a restart marker');
  restart[at] = 0x11;
  restart[at + 1] = 0x11;
  assert.throws(() => decodeJpeg(restart), /restart marker/);
});

test('absurd dimensions are refused before any memory is allocated', () => {
  const huge = Buffer.from(bytes(DECODABLE.ycc444Restart.jpeg));
  const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  huge.writeUInt16BE(65535, sof + 5); // height
  huge.writeUInt16BE(65535, sof + 7); // width
  assert.throws(() => decodeJpeg(huge), /dimensions/);
});

test('a JPEG that stores RGB (Adobe transform 0, or component ids R, G, B) is decoded as RGB, like libjpeg does', () => {
  const blocks = [[[4, 4], [200, 40, 40]], [[12, 4], [20, 60, 200]], [[4, 12], [30, 170, 60]], [[12, 12], [240, 220, 30]]];
  for (const [label, fixture] of [['Adobe transform 0', ADOBE_RGB_JPEG], ['component ids R, G, B', ID_RGB_JPEG]]) {
    const decoded = decodeJpeg(bytes(fixture));
    assert.deepEqual([decoded.width, decoded.height], [16, 16]);
    for (const [[x, y], expected] of blocks) {
      const offset = (y * 16 + x) * 4;
      const actual = [...decoded.rgba.subarray(offset, offset + 3)];
      assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 3), `${label}: (${x},${y}) is ${actual}, expected ${expected}`);
    }
  }
});

test('a 128 px 4:2:0 JPEG decodes at its full size and matches libjpeg at sample pixels', () => {
  const decoded = decodeJpeg(bytes(SQUARE_420_JPEG));
  assert.deepEqual([decoded.width, decoded.height, decoded.rgba.length], [128, 128, 128 * 128 * 4]);
  // libjpeg (Pillow 12.2) at these pixels; the upsampled chroma may differ by a level or two
  const reference = [[[0, 0], [253, 240, 255]], [[16, 16], [243, 244, 255]], [[40, 90], [80, 175, 131]], [[64, 64], [255, 239, 239]],
    [[100, 30], [205, 59, 222]], [[127, 127], [255, 255, 195]]];
  for (const [[x, y], expected] of reference) {
    const offset = (y * 128 + x) * 4;
    const actual = [...decoded.rgba.subarray(offset, offset + 3)];
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 3), `(${x},${y}) is ${actual}, libjpeg gives ${expected}`);
  }
});
