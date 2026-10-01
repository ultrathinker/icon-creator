import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '../scripts/lib/png.mjs';
import { buildIco, parseIco } from '../scripts/lib/ico.mjs';

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

test('buildIco writes a header and directory that parseIco reads back exactly', () => {
  const ico = buildIco([
    { size: 256, png: solidPng(256, 1, 2, 3) },
    { size: 16, png: solidPng(16, 4, 5, 6) },
    { size: 48, png: solidPng(48, 7, 8, 9) },
  ]);
  const parsed = parseIco(ico);
  assert.equal(parsed.count, 3);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.declaredWidth),
    [16, 48, 256],
  );
  for (const entry of parsed.entries) {
    assert.equal(entry.isPng, true);
    assert.equal(entry.pngSize.width, entry.declaredWidth);
  }
});

test('a 256 px entry is stored as width/height byte 0', () => {
  const ico = buildIco([{ size: 256, png: solidPng(256, 0, 0, 0) }]);
  assert.equal(ico[6], 0);
  assert.equal(ico[7], 0);
  const parsed = parseIco(ico);
  assert.equal(parsed.entries[0].declaredWidth, 256);
});

test('directory entries point at non-overlapping PNG data', () => {
  const ico = buildIco([
    { size: 16, png: solidPng(16, 10, 0, 0) },
    { size: 32, png: solidPng(32, 0, 20, 0) },
  ]);
  const parsed = parseIco(ico);
  const [first, second] = parsed.entries;
  assert.equal(first.offset, 6 + 2 * 16);
  assert.equal(second.offset, first.offset + first.byteCount);
  assert.equal(6 + 2 * 16 + first.byteCount + second.byteCount, ico.length);
});

test('buildIco rejects a PNG whose size disagrees with its entry', () => {
  assert.throws(
    () => buildIco([{ size: 32, png: solidPng(48, 0, 0, 0) }]),
    /says 32px but the PNG is 48x48|claims 32px/,
  );
});

test('parseIco rejects a corrupted directory offset', () => {
  const ico = buildIco([{ size: 16, png: solidPng(16, 0, 0, 0) }]);
  ico.writeUInt32LE(0xffff00, 6 + 12); // offset of the first entry
  assert.throws(() => parseIco(ico), /past the end of the file/);
});
