// Reading an image file the user names: the first place this tool opens a file
// it did not generate. Everything here is defensive.
//
//  - the path must be a regular file reached through real directories (no
//    symbolic link or junction anywhere in the chain), within a byte cap;
//  - the format comes from the CONTENT (magic bytes), never from the file
//    extension, and the pixel dimensions come from the HEADER, checked against
//    a cap BEFORE any pixel is decoded (decompression-bomb guard);
//  - metadata (EXIF, ICC, comments, text chunks) is never interpreted;
//  - nothing in the file is executed or fetched: a raster is only ever
//    decoded to pixels, an SVG goes through the existing validator.

import fs from 'node:fs';
import path from 'node:path';
import { assertRealParentChain } from './publish.mjs';

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SIDE = 8192;
export const SUPPORTED_FORMATS = 'PNG, JPEG, WebP, GIF, BMP or SVG';

/** Detect the format from the first bytes. Returns a lowercase name or null. */
export function detectFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  const head6 = buffer.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  // SVG is text: after an optional byte-order mark and whitespace it starts
  // with "<" (XML declaration, comment or the root). The SVG validator decides
  // whether it really is one; a NUL byte means binary, not SVG.
  let start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  while (start < buffer.length && (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0a || buffer[start] === 0x0d)) start += 1;
  if (buffer[start] === 0x3c && !buffer.subarray(start, Math.min(buffer.length, start + 4096)).includes(0)) return 'svg';
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('the JPEG is malformed (expected a marker)');
    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1; // fill bytes
      marker = buffer[offset + 1];
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan before any frame header
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 7 > buffer.length) break;
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error('the JPEG has no frame header (truncated or not a real JPEG)');
}

function webpDimensions(buffer) {
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  throw new Error('the WebP has an unrecognised header');
}

function bmpDimensions(buffer) {
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize === 12) return { width: buffer.readUInt16LE(18), height: buffer.readUInt16LE(20) };
  if (headerSize >= 40 && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  throw new Error('the BMP has an unrecognised header');
}

/**
 * Refuse a file whose header is fine but whose body is cut short. The browser
 * is lenient (it shows a truncated JPEG or WebP as a partly grey or blank
 * picture and reports success), so completeness is checked here from the
 * container structure itself.
 */
export function assertComplete(buffer, format) {
  if (format === 'jpeg') {
    // Entropy-coded data cannot contain FF D9 (a literal FF is stuffed as FF 00),
    // so an end-of-image marker after the first scan header means the stream ends properly.
    let offset = 2;
    let scan = -1;
    while (offset + 4 <= buffer.length && scan < 0) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xda) {
        scan = offset;
        break;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    if (scan < 0 || buffer.indexOf(Buffer.from([0xff, 0xd9]), scan + 2) < 0) {
      throw new Error('the JPEG is truncated or corrupt (no end-of-image marker after the image data)');
    }
  } else if (format === 'webp') {
    const declared = buffer.readUInt32LE(4) + 8;
    if (declared > buffer.length) {
      throw new Error(`the WebP is truncated (its header declares ${declared} bytes, the file has ${buffer.length})`);
    }
    if (buffer.length >= 20 && 20 + buffer.readUInt32LE(16) > buffer.length) {
      throw new Error('the WebP is truncated (its first chunk runs past the end of the file)');
    }
  } else if (format === 'bmp') {
    const dataOffset = buffer.readUInt32LE(10);
    const headerSize = buffer.readUInt32LE(14);
    const small = headerSize === 12;
    const width = small ? buffer.readUInt16LE(18) : Math.abs(buffer.readInt32LE(18));
    const height = small ? buffer.readUInt16LE(20) : Math.abs(buffer.readInt32LE(22));
    const bitsPerPixel = buffer.readUInt16LE(small ? 24 : 28);
    const compression = small ? 0 : buffer.readUInt32LE(30);
    if (dataOffset >= buffer.length) throw new Error('the BMP is truncated (no pixel data)');
    if (compression === 0 || compression === 3) {
      const rowBytes = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
      if (dataOffset + rowBytes * height > buffer.length) {
        throw new Error('the BMP is truncated (the pixel rows run past the end of the file)');
      }
    }
  }
}

/** Pixel dimensions read from the header only. Throws on a malformed header. */
export function headerDimensions(buffer, format) {
  switch (format) {
    case 'png': {
      if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') throw new Error('the PNG has no IHDR header');
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    case 'jpeg': return jpegDimensions(buffer);
    case 'gif': return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    case 'webp': return webpDimensions(buffer);
    case 'bmp': return bmpDimensions(buffer);
    default: throw new Error(`no pixel dimensions for ${format}`);
  }
}

/** Throw when the dimensions are empty or beyond the cap. */
export function assertDimensions(width, height, label = 'the image') {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`${label} reports an empty size (${width}x${height})`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(
      `${label} is ${width}x${height} px; the limit is ${MAX_SIDE}x${MAX_SIDE}. ` +
        'Shrink it first (an icon never needs more than 1024 px).',
    );
  }
}

/**
 * Open and classify the file the user named. Refuses anything that is not a
 * regular, readable file reached through real directories, anything over the
 * byte cap, anything whose content is not a supported image, and (before any
 * decoding) anything whose header dimensions exceed the cap.
 * Returns { path, buffer, format, width, height } (width/height are null for
 * SVG, which has no pixel size).
 */
export function loadSource(filePath) {
  const absolute = path.resolve(filePath);
  assertRealParentChain(absolute);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw new Error(`cannot read ${absolute}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${absolute} is a symbolic link: refusing to follow it - pass the real path of the file`);
  }
  if (!stat.isFile()) {
    throw new Error(`${absolute} is not a regular file (directories, devices and pipes are refused)`);
  }
  if (stat.size === 0) throw new Error(`${absolute} is empty`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new Error(
      `${absolute} is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${MAX_INPUT_BYTES / 1048576} MB. ` +
        'Use a smaller export of the image.',
    );
  }
  let buffer;
  try {
    const fd = fs.openSync(absolute, 'r');
    try {
      // Read at most cap + 1 bytes so a file that grows after the stat check
      // still cannot exceed the cap.
      const chunk = Buffer.alloc(Math.min(stat.size, MAX_INPUT_BYTES) + 1);
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      if (read > stat.size || read > MAX_INPUT_BYTES) throw new Error(`${absolute} changed size while it was being read; try again`);
      buffer = chunk.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.message.includes('while it was being read')) throw error;
    throw new Error(`cannot read ${absolute}: ${error.message}`);
  }
  const format = detectFormat(buffer);
  if (format === null) {
    throw new Error(`${absolute} is not a supported image: its content is not ${SUPPORTED_FORMATS} (the file extension is ignored).`);
  }
  if (format === 'svg') return { path: absolute, buffer, format, width: null, height: null };
  let dimensions;
  try {
    dimensions = headerDimensions(buffer, format);
  } catch (error) {
    throw new Error(`${absolute}: ${error.message}`);
  }
  assertDimensions(dimensions.width, dimensions.height, absolute);
  try {
    assertComplete(buffer, format);
  } catch (error) {
    throw new Error(`${absolute}: ${error.message}`);
  }
  return { path: absolute, buffer, format, width: dimensions.width, height: dimensions.height };
}

// ---------------------------------------------------------------------------
// GIF: first frame only, decoded by hand. A browser screenshot of an animated
// GIF shows whichever frame is on screen at that moment (measured: frame 2 of
// a 20 ms animation), so the first frame cannot be taken from the browser.

function readSubBlocks(buffer, offset) {
  const parts = [];
  let position = offset;
  for (;;) {
    if (position >= buffer.length) throw new Error('the GIF is truncated');
    const size = buffer[position];
    position += 1;
    if (size === 0) break;
    if (position + size > buffer.length) throw new Error('the GIF is truncated');
    parts.push(buffer.subarray(position, position + size));
    position += size;
  }
  return { data: Buffer.concat(parts), next: position };
}

function lzwDecode(data, minCodeSize, pixelCount) {
  if (minCodeSize < 1 || minCodeSize > 11) throw new Error('the GIF has an invalid LZW code size');
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  const out = new Uint8Array(pixelCount);
  let outPos = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = end + 1;
  let previous = -1;
  let firstByte = 0;
  let bits = 0;
  let bitCount = 0;
  let index = 0;
  while (outPos < pixelCount) {
    while (bitCount < codeSize) {
      if (index >= data.length) throw new Error('the GIF image data ends before all pixels were decoded');
      bits |= data[index] << bitCount;
      index += 1;
      bitCount += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      nextCode = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) {
      if (outPos < pixelCount) throw new Error('the GIF image data ends before all pixels were decoded');
      break;
    }
    let current = code;
    let top = 0;
    if (previous === -1) {
      if (code >= clear) throw new Error('the GIF data is corrupt');
      out[outPos] = code;
      outPos += 1;
      previous = code;
      firstByte = code;
      continue;
    }
    if (code >= nextCode) {
      if (code > nextCode) throw new Error('the GIF data is corrupt');
      stack[top] = firstByte;
      top += 1;
      current = previous;
    }
    while (current >= clear) {
      stack[top] = suffix[current];
      top += 1;
      current = prefix[current];
    }
    firstByte = current;
    stack[top] = current;
    top += 1;
    while (top > 0 && outPos < pixelCount) {
      top -= 1;
      out[outPos] = stack[top];
      outPos += 1;
    }
    if (nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = firstByte;
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }
  return out;
}

/**
 * Decode the first frame of a GIF onto a transparent canvas of the logical
 * screen size. Returns { width, height, rgba, frames } where `frames` is 1 or
 * 2 (2 means "at least one more frame follows, which is ignored").
 */
export function decodeGifFirstFrame(buffer) {
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  assertDimensions(width, height, 'the GIF');
  const flags = buffer[10];
  let position = 13;
  let globalTable = null;
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1));
    if (position + size > buffer.length) throw new Error('the GIF is truncated');
    globalTable = buffer.subarray(position, position + size);
    position += size;
  }
  let transparentIndex = -1;
  while (position < buffer.length) {
    const block = buffer[position];
    position += 1;
    if (block === 0x21) {
      const label = buffer[position];
      position += 1;
      if (label === 0xf9 && buffer[position] >= 4) {
        if (buffer[position + 1] & 1) transparentIndex = buffer[position + 4];
      }
      position = readSubBlocks(buffer, position).next;
    } else if (block === 0x2c) {
      if (position + 9 > buffer.length) throw new Error('the GIF is truncated');
      const left = buffer.readUInt16LE(position);
      const top = buffer.readUInt16LE(position + 2);
      const frameWidth = buffer.readUInt16LE(position + 4);
      const frameHeight = buffer.readUInt16LE(position + 6);
      const frameFlags = buffer[position + 8];
      position += 9;
      let table = globalTable;
      if (frameFlags & 0x80) {
        const size = 3 * (1 << ((frameFlags & 7) + 1));
        if (position + size > buffer.length) throw new Error('the GIF is truncated');
        table = buffer.subarray(position, position + size);
        position += size;
      }
      if (table === null) throw new Error('the GIF has no colour table');
      assertDimensions(frameWidth, frameHeight, 'the GIF frame');
      const minCodeSize = buffer[position];
      position += 1;
      const { data, next } = readSubBlocks(buffer, position);
      const indices = lzwDecode(data, minCodeSize, frameWidth * frameHeight);
      const interlaced = Boolean(frameFlags & 0x40);
      const rowOrder = [];
      if (interlaced) {
        for (const [startRow, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let row = startRow; row < frameHeight; row += step) rowOrder.push(row);
        }
      }
      const rgba = Buffer.alloc(width * height * 4);
      for (let row = 0; row < frameHeight; row += 1) {
        const y = top + (interlaced ? rowOrder[row] : row);
        if (y >= height) continue;
        for (let column = 0; column < frameWidth; column += 1) {
          const x = left + column;
          if (x >= width) continue;
          const colorIndex = indices[row * frameWidth + column];
          if (colorIndex === transparentIndex || colorIndex * 3 + 2 >= table.length) continue;
          const o = (y * width + x) * 4;
          rgba[o] = table[colorIndex * 3];
          rgba[o + 1] = table[colorIndex * 3 + 1];
          rgba[o + 2] = table[colorIndex * 3 + 2];
          rgba[o + 3] = 255;
        }
      }
      // Another image, or a graphic-control block (which only precedes a
      // frame), means the GIF is animated; comments and other extensions do not.
      const more = buffer[next] === 0x2c || (buffer[next] === 0x21 && buffer[next + 1] === 0xf9);
      return { width, height, rgba, frames: more ? 2 : 1 };
    } else if (block === 0x3b) {
      break;
    } else {
      throw new Error('the GIF is malformed (unknown block)');
    }
  }
  throw new Error('the GIF has no image data');
}
