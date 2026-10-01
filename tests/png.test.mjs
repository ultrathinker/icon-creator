import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodePng, decodePng, pngInfo, analyzeRgba, crc32 } from '../scripts/lib/png.mjs';

function solidRgba(size, r, g, b, a) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}

test('encodePng produces a PNG that pngInfo and decodePng read back', () => {
  const png = encodePng(4, 4, solidRgba(4, 200, 10, 30, 255));
  const info = pngInfo(png);
  assert.equal(info.width, 4);
  assert.equal(info.height, 4);
  assert.equal(info.colorType, 6);
  const decoded = decodePng(png);
  assert.equal(decoded.rgba.length, 4 * 4 * 4);
  assert.equal(decoded.rgba[0], 200);
  assert.equal(decoded.rgba[3], 255);
});

test('decodePng reverses every PNG filter type, including Paeth', () => {
  // Hand-build a 3x2 RGBA image whose raw scanlines use a different filter
  // per row, so the decoder must exercise filter codes 0..4 correctly.
  const width = 3;
  const height = 5;
  const rows = [
    [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [50, 40, 30, 20, 10, 50, 40, 30, 20, 10, 50, 40],
    [99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88],
    [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
  ];
  const filters = [0, 1, 2, 3, 4];
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const reference = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filters[y];
    for (let i = 0; i < stride; i += 1) {
      raw[y * (stride + 1) + 1 + i] = rows[y][i];
      const a = i >= 4 ? reference[y * stride + i - 4] : 0;
      const b = y > 0 ? reference[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? reference[(y - 1) * stride + i - 4] : 0;
      const paeth = (() => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      })();
      let value = rows[y][i];
      if (filters[y] === 1) value += a;
      else if (filters[y] === 2) value += b;
      else if (filters[y] === 3) value += (a + b) >> 1;
      else if (filters[y] === 4) value += paeth;
      reference[y * stride + i] = value & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
    return Buffer.concat([head, data, tail]);
  };
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const decoded = decodePng(png);
  assert.deepEqual(decoded.rgba, reference);
});

test('decodePng handles split IDAT chunks', () => {
  const png = encodePng(2, 2, solidRgba(2, 0, 255, 0, 128));
  const idatChunkStart = png.indexOf(Buffer.from('IDAT')) - 4;
  const idatLength = png.readUInt32BE(idatChunkStart);
  const idat = png.subarray(idatChunkStart + 8, idatChunkStart + 8 + idatLength);
  const iendChunkStart = png.indexOf(Buffer.from('IEND')) - 4;
  const half = Math.floor(idat.length / 2);
  const makeChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
    return Buffer.concat([head, data, tail]);
  };
  const split = Buffer.concat([
    png.subarray(0, idatChunkStart),
    makeChunk('IDAT', idat.subarray(0, half)),
    makeChunk('IDAT', idat.subarray(half)),
    png.subarray(iendChunkStart),
  ]);
  const decoded = decodePng(split);
  assert.equal(decoded.rgba[1], 255);
  assert.equal(decoded.rgba[3], 128);
});

test('pngInfo rejects a non-PNG buffer', () => {
  assert.throws(() => pngInfo(Buffer.from('not a png at all')), /Not a PNG/);
});

test('analyzeRgba reports corner alpha, visibility and the bounding box', () => {
  const size = 10;
  const rgba = Buffer.alloc(size * size * 4); // fully transparent
  // An opaque square from (2,2) to (7,7): 6x6 visible pixels.
  for (let y = 2; y <= 7; y += 1) {
    for (let x = 2; x <= 7; x += 1) {
      rgba[(y * size + x) * 4] = 255;
      rgba[(y * size + x) * 4 + 3] = 255;
    }
  }
  const analysis = analyzeRgba(size, size, rgba);
  assert.deepEqual(analysis.cornerAlphas, [0, 0, 0, 0]);
  assert.equal(analysis.visibleRatio, 36 / 100);
  assert.deepEqual(analysis.bbox, { x: 2, y: 2, width: 6, height: 6 });
});

test('analyzeRgba reports opaque corners when the image is full-bleed', () => {
  const rgba = solidRgba(4, 9, 9, 9, 255);
  const analysis = analyzeRgba(4, 4, rgba);
  assert.deepEqual(analysis.cornerAlphas, [255, 255, 255, 255]);
  assert.equal(analysis.bbox.width, 4);
});
