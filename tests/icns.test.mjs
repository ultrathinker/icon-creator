import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '../scripts/lib/png.mjs';
import { buildIcns, parseIcns, ICNS_PNG_TYPES } from '../scripts/lib/icns.mjs';

function solidPng(size, r, g, b) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(size, size, rgba);
}

function fullSet() {
  const map = new Map();
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    map.set(size, solidPng(size, size % 256, 64, 128));
  }
  return map;
}

test('the chunk table matches the published ICNS types and pixel sizes', () => {
  const expected = {
    icp4: 16, icp5: 32, ic11: 32, icp6: 64, ic12: 64, ic07: 128,
    ic08: 256, ic13: 256, ic09: 512, ic14: 512, ic10: 1024,
  };
  assert.deepEqual(
    Object.fromEntries(ICNS_PNG_TYPES.map((entry) => [entry.type, entry.size])),
    expected,
  );
});

test('buildIcns writes all eleven chunks and parses back with matching sizes', () => {
  const icns = buildIcns(fullSet());
  const parsed = parseIcns(icns);
  assert.equal(parsed.chunks.length, 11);
  assert.equal(parsed.totalLength, icns.length);
  for (const chunk of parsed.chunks) {
    assert.equal(chunk.expectedSize !== null, true, `chunk ${chunk.type} should be known`);
    assert.equal(chunk.pngSize.width, chunk.expectedSize);
    assert.equal(chunk.pngSize.height, chunk.expectedSize);
    // The length field must include the 8-byte chunk header itself.
    assert.equal(chunk.dataLength + 8, icns.readUInt32BE(chunk.offset + 4));
  }
});

test('retina chunk types reuse the @1x pixels of the same size', () => {
  const map = fullSet();
  const icns = buildIcns(map);
  const parsed = parseIcns(icns);
  const icp5 = parsed.chunks.find((chunk) => chunk.type === 'icp5');
  const ic11 = parsed.chunks.find((chunk) => chunk.type === 'ic11');
  assert.equal(icp5.dataLength, ic11.dataLength);
  assert.equal(icp5.pngSize.width, 32);
  assert.equal(ic11.pngSize.width, 32);
});

test('the file header length field equals the exact byte count of the file', () => {
  const icns = buildIcns(fullSet());
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
});

test('buildIcns refuses a set with missing sizes', () => {
  const map = fullSet();
  map.delete(512);
  assert.throws(() => buildIcns(map), /missing renders.*512/);
});

test('parseIcns rejects a file whose header length disagrees with its size', () => {
  const icns = buildIcns(fullSet());
  const truncated = icns.subarray(0, icns.length - 10);
  assert.throws(() => parseIcns(truncated), /says \d+ bytes, file has/);
});

test('parseIcns rejects a chunk whose payload is the wrong size for its type', () => {
  const map = fullSet();
  map.set(16, solidPng(20, 1, 2, 3)); // 20px PNG in the 16px slot
  assert.throws(() => buildIcns(map), /icp4 needs 16px/);
});
