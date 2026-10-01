// Tests for the import pipeline: resizing and fitting, the three background
// modes, the warnings, and the end-to-end import into files. Synthetic pixels
// only (plus the tiny fixtures in tests/fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, analyzeRgba, encodePng } from '../scripts/lib/png.mjs';
import { loadSource } from '../scripts/lib/imagefile.mjs';
import { resizeArea, fitToSquare, removeBackground, cornerPixels } from '../scripts/lib/pixels.mjs';
import {
  prepareMaster,
  chooseBackground,
  decodeSource,
  importImage,
  wrapperSvg,
  describeImport,
  DEFAULT_TOLERANCE,
} from '../scripts/lib/importimg.mjs';
import { validateSvg } from '../scripts/lib/svgcheck.mjs';
import { isRasterMaster } from '../scripts/lib/export.mjs';
import {
  FIXTURES,
  withTemp,
  linkSkipReason,
  canvas,
  setPixel,
  getPixel,
  ringOnBackground,
  glyphIcon,
  writePng,
  makePng16,
} from './import-helpers.mjs';
import { dirLinkSkipReason, makeAliasedTemp, makeDirLink, withCwd } from './helpers.mjs';

const WHITE = [255, 255, 255, 255];

// ---- resizing and fitting ----------------------------------------------------

test('resizeArea averages in premultiplied alpha, so transparent pixels never darken colour', () => {
  // 2x2 -> 1x1: one opaque red pixel and three transparent black ones.
  const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...resizeArea(rgba, 2, 2, 1, 1)], [255, 0, 0, 64]);
  // 4x1 -> 2x1 plain average of opaque pixels.
  const row = Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 200, 200, 200, 255]);
  assert.deepEqual([...resizeArea(row, 4, 1, 2, 1)], [50, 50, 50, 255, 200, 200, 200, 255]);
  // Equal size is a copy.
  assert.deepEqual(resizeArea(row, 4, 1, 4, 1), row);
});

test('fitToSquare centres a wide picture on a transparent square without stretching or cropping', () => {
  const red = [200, 20, 20, 255];
  const fit = fitToSquare(canvas(200, 100, red), 200, 100, 1024);
  assert.equal(fit.size, 200, 'no upscaling: the square is as big as the longer side');
  assert.deepEqual(fit.content, { x: 0, y: 50, width: 200, height: 100 });
  assert.equal(fit.padded, true);
  assert.equal(fit.downscaled, false);
  assert.deepEqual(getPixel(fit.rgba, 200, 100, 100), red);
  assert.equal(getPixel(fit.rgba, 200, 100, 49)[3], 0, 'padding above is transparent');
  assert.equal(getPixel(fit.rgba, 200, 100, 150)[3], 0, 'padding below is transparent');
  assert.deepEqual(getPixel(fit.rgba, 200, 0, 50), red, 'the full width is kept (not cropped)');
  assert.deepEqual(getPixel(fit.rgba, 200, 199, 149), red);

  const tall = fitToSquare(canvas(100, 300, red), 100, 300, 1024);
  assert.deepEqual(tall.content, { x: 100, y: 0, width: 100, height: 300 });
});

test('fitToSquare shrinks large sources to the master size and never enlarges small ones', () => {
  const big = fitToSquare(canvas(3000, 1500, [0, 0, 255, 255]), 3000, 1500, 1024);
  assert.equal(big.size, 1024);
  assert.deepEqual(big.content, { x: 0, y: 256, width: 1024, height: 512 });
  assert.equal(big.downscaled, true);
  const exact = fitToSquare(canvas(64, 64, [1, 2, 3, 255]), 64, 64, 1024);
  assert.equal(exact.size, 64);
  assert.equal(exact.padded, false);
  assert.equal(exact.downscaled, false);
});

// ---- background handling -----------------------------------------------------

test('remove: the flood fill clears the background but keeps an enclosed light area', () => {
  const size = 96;
  const ring = ringOnBackground(size, WHITE);
  const result = removeBackground(ring, size, size, { r: 255, g: 255, b: 255 }, DEFAULT_TOLERANCE);
  assert.equal(getPixel(result.rgba, size, 0, 0)[3], 0);
  assert.equal(getPixel(result.rgba, size, size - 1, size - 1)[3], 0);
  const c = Math.floor(size / 2);
  assert.deepEqual(getPixel(result.rgba, size, c, c), WHITE, 'the white hole inside the ring survives');
  assert.deepEqual(getPixel(result.rgba, size, c - Math.round(size * 0.3), c), [200, 30, 30, 255], 'solid ring colour is untouched');
  assert.ok(result.transparent > size * size * 0.2, 'a large share of the picture was background');
});

test('remove: anti-aliased edge pixels become partly transparent red, not light halo pixels', () => {
  const size = 96;
  const ring = ringOnBackground(size, WHITE);
  const result = removeBackground(ring, size, size, { r: 255, g: 255, b: 255 }, DEFAULT_TOLERANCE);
  const middle = Math.round((size - 1) / 2);
  // Every non-transparent pixel across the ring's OUTER edge (the left 20% of the
  // axis) must be red-ish: a washed-out pink, the un-cleaned blend with white,
  // would have a high green channel. (The inner edge borders the enclosed hole,
  // which is deliberately kept, so it is not scanned.)
  let softPixels = 0;
  for (let x = 0; x < size * 0.2; x += 1) {
    const [r, g, b, a] = getPixel(result.rgba, size, x, middle);
    if (a === 0) continue;
    assert.ok(r >= 170 && g <= 100 && b <= 100, `pixel ${x} keeps the ring colour (got ${r},${g},${b},${a})`);
    if (a < 255) softPixels += 1;
  }
  assert.ok(softPixels >= 1, 'the soft edge became partial transparency');
  assert.ok(result.softened > 0);
});

test('remove: tolerance decides how much background noise counts as background', () => {
  const size = 64;
  const rgba = canvas(size, size, [240, 240, 240, 255]);
  for (let x = 0; x < size; x += 1) setPixel(rgba, size, x, 2, [220, 220, 220, 255]); // a band 20 away from the background
  for (let y = 20; y < 44; y += 1) for (let x = 20; x < 44; x += 1) setPixel(rgba, size, x, y, [20, 20, 90, 255]);
  const strict = removeBackground(rgba, size, size, { r: 240, g: 240, b: 240 }, 8);
  const loose = removeBackground(rgba, size, size, { r: 240, g: 240, b: 240 }, 32);
  assert.equal(getPixel(strict.rgba, size, 10, 2)[3], 255, 'the band survives at tolerance 8');
  assert.equal(getPixel(loose.rgba, size, 10, 2)[3], 0, 'the same band is background at tolerance 32');
  assert.ok(loose.transparent > strict.transparent);
});

test('auto: transparent corners are kept, a plain background is removed, anything else is kept with a warning', () => {
  const size = 64;
  const options = { mode: 'auto', width: size, height: size, tolerance: DEFAULT_TOLERANCE };
  const clear = chooseBackground({ ...options, rgba: glyphIcon(size) });
  assert.equal(clear.action, 'keep');
  assert.match(clear.reason, /already transparent/);
  assert.deepEqual(clear.warnings, []);

  const plain = chooseBackground({ ...options, rgba: ringOnBackground(size, [250, 250, 250, 255]) });
  assert.equal(plain.action, 'remove');
  assert.deepEqual(plain.reference, { r: 250, g: 250, b: 250 });

  const gradient = canvas(size, size, [0, 0, 0, 255]);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) setPixel(gradient, size, x, y, [x * 4, y * 4, 128, 255]);
  const photo = chooseBackground({ ...options, rgba: gradient });
  assert.equal(photo.action, 'keep');
  assert.equal(photo.warnings[0].code, 'background-uncertain');

  // Mixed corners (one opaque, the rest transparent) are not "uniform" either.
  const mixed = glyphIcon(size);
  setPixel(mixed, size, 0, 0, [255, 255, 255, 255]);
  assert.equal(chooseBackground({ ...options, rgba: mixed }).action, 'keep');
});

test('keep leaves the background alone and remove on a transparent border changes nothing', () => {
  const size = 64;
  const opaque = ringOnBackground(size, WHITE);
  const keep = prepareMaster({ decoded: { width: size, height: size, rgba: opaque }, background: 'keep' });
  assert.deepEqual(keep.facts.cornerAlphaAfter, [255, 255, 255, 255]);
  assert.equal(keep.facts.madeTransparentPercent, 0);
  assert.ok(keep.warnings.some((w) => w.code === 'opaque-corners' && /every export target will refuse/.test(w.message)));

  const alreadyClear = chooseBackground({ mode: 'remove', rgba: glyphIcon(size), width: size, height: size, tolerance: 32 });
  assert.equal(alreadyClear.action, 'keep');
  assert.match(alreadyClear.reason, /already transparent/);
  assert.throws(() => chooseBackground({ mode: 'sideways', rgba: opaque, width: size, height: size, tolerance: 32 }), /--background must be one of/);
});

test('prepareMaster reports the measured facts: corner alpha before/after and the transparent share', () => {
  const size = 200;
  const master = prepareMaster({ decoded: { width: size, height: size, rgba: ringOnBackground(size, WHITE) }, background: 'auto' });
  assert.deepEqual(master.facts.cornerAlphaBefore, [255, 255, 255, 255]);
  assert.deepEqual(master.facts.cornerAlphaAfter, [0, 0, 0, 0]);
  // The ring covers about pi*(0.42^2 - 0.16^2) = 47% of the square; the rest outside it is background.
  assert.ok(master.facts.madeTransparentPercent > 35 && master.facts.madeTransparentPercent < 50, `made transparent: ${master.facts.madeTransparentPercent}`);
  assert.equal(master.facts.background.action, 'remove');
  assert.equal(master.facts.hasAlpha, false);
  const decoded = decodePng(master.png);
  assert.equal(decoded.width, master.size);
  assert.deepEqual(analyzeRgba(decoded.width, decoded.height, decoded.rgba).cornerAlphas, [0, 0, 0, 0]);
});

// ---- warnings ----------------------------------------------------------------

const codes = (master) => master.warnings.map((warning) => warning.code);

test('a healthy, large, transparent icon produces no warnings', () => {
  const size = 600;
  const master = prepareMaster({ decoded: { width: size, height: size, rgba: glyphIcon(size) } });
  assert.deepEqual(codes(master), []);
  assert.equal(master.size, size);
});

test('warning: a source under 512 px is flagged as soft at large sizes', () => {
  const master = prepareMaster({ decoded: { width: 128, height: 128, rgba: glyphIcon(128) }, sourceWidth: 128, sourceHeight: 128 });
  assert.ok(codes(master).includes('low-resolution'));
  assert.match(master.warnings.find((w) => w.code === 'low-resolution').message, /only 128 px.*soft/);
  assert.ok(!codes(prepareMaster({ decoded: { width: 512, height: 512, rgba: glyphIcon(512) } })).includes('low-resolution'));
});

test('warning: heavy padding and artwork touching the edge', () => {
  const size = 600;
  const tiny = canvas(size, size, [0, 0, 0, 0]);
  for (let y = 250; y < 350; y += 1) for (let x = 250; x < 350; x += 1) setPixel(tiny, size, x, y, [200, 30, 30, 255]);
  assert.ok(codes(prepareMaster({ decoded: { width: size, height: size, rgba: tiny } })).includes('heavy-padding'));

  const bleed = canvas(size, size, [30, 41, 120, 255]);
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) setPixel(bleed, size, x, y, [0, 0, 0, 0]);
  const bleedCodes = codes(prepareMaster({ decoded: { width: size, height: size, rgba: bleed } }));
  assert.ok(bleedCodes.includes('touches-edge'));
  assert.ok(!bleedCodes.includes('heavy-padding'));
});

test('warning: background removal that eats most of the picture', () => {
  const size = 600;
  const rgba = canvas(size, size, WHITE);
  for (let y = 280; y < 320; y += 1) for (let x = 280; x < 320; x += 1) setPixel(rgba, size, x, y, [200, 30, 30, 255]);
  const master = prepareMaster({ decoded: { width: size, height: size, rgba }, background: 'auto' });
  assert.ok(codes(master).includes('removal-heavy'));
  assert.match(master.warnings.find((w) => w.code === 'removal-heavy').message, /9\d\.\d% of the picture/);
});

test('warning: a flat blob that is mush at 16 px, with the honest options', () => {
  const size = 600;
  const blob = canvas(size, size, [0, 0, 0, 0]);
  for (let y = 40; y < size - 40; y += 1) for (let x = 40; x < size - 40; x += 1) setPixel(blob, size, x, y, [30, 41, 120, 255]);
  const master = prepareMaster({ decoded: { width: size, height: size, rgba: blob } });
  const mush = master.warnings.find((w) => w.code === 'mush-16');
  assert.ok(mush, 'flat colour at 16 px is flagged');
  assert.match(mush.message, /cannot get a hand-drawn small variant/);
  assert.match(mush.message, /accept it, supply a simpler image.*drawn as SVG/);
});

test('warning: a non-square picture that keeps its opaque background looks like a card', () => {
  const rgba = canvas(300, 200, [250, 240, 200, 255]);
  const master = prepareMaster({ decoded: { width: 300, height: 200, rgba }, background: 'keep' });
  const warning = master.warnings.find((w) => w.code === 'opaque-corners');
  assert.ok(warning);
  assert.match(warning.message, /centred on a transparent square.*card/);
  assert.deepEqual(master.facts.cornerAlphaAfter, [0, 0, 0, 0], 'the padded canvas corners are transparent');
});

test('a non-square picture is fitted, not stretched, in the prepared master', () => {
  const rgba = canvas(300, 100, [0, 0, 0, 0]);
  for (let y = 0; y < 100; y += 1) for (let x = 100; x < 200; x += 1) setPixel(rgba, 300, x, y, [200, 30, 30, 255]);
  const master = prepareMaster({ decoded: { width: 300, height: 100, rgba }, background: 'keep' });
  assert.equal(master.size, 300);
  assert.deepEqual(master.facts.fit.content, { x: 0, y: 100, width: 300, height: 100 });
  const decoded = decodePng(master.png);
  assert.deepEqual(analyzeRgba(300, 300, decoded.rgba).bbox, { x: 100, y: 100, width: 100, height: 100 }, 'the red square is still square');
});

// ---- decoding sources and the full import -----------------------------------

test('decodeSource uses the built-in codecs for PNG and GIF and the injected browser for the rest', async () => {
  await withTemp(async (dir) => {
    const pngFile = writePng(path.join(dir, 'a.png'), 8, 8, canvas(8, 8, [9, 8, 7, 255]));
    const png = await decodeSource(loadSource(pngFile), { browserDecode: null });
    assert.equal(png.via, 'built-in PNG codec');
    assert.deepEqual(getPixel(png.rgba, 8, 3, 3), [9, 8, 7, 255]);

    const gif = await decodeSource(loadSource(path.join(FIXTURES, 'import-anim.gif')), { browserDecode: null });
    assert.equal(gif.via, 'built-in GIF decoder');
    assert.equal(gif.frames, 2);

    await assert.rejects(decodeSource(loadSource(path.join(FIXTURES, 'import-white.jpg')), { browserDecode: null }), /needs a headless browser/);

    let asked = null;
    const fake = async (request) => {
      asked = request;
      return { width: request.width, height: request.height, rgba: canvas(request.width, request.height, [1, 2, 3, 255]) };
    };
    const jpeg = await decodeSource(loadSource(path.join(FIXTURES, 'import-white.jpg')), { browserDecode: fake });
    assert.equal(jpeg.via, 'browser');
    assert.deepEqual([asked.width, asked.height, path.basename(asked.imagePath)], [96, 96, 'import-white.jpg']);

    const wrongSize = async () => ({ width: 10, height: 10, rgba: canvas(10, 10, [0, 0, 0, 255]) });
    await assert.rejects(decodeSource(loadSource(path.join(FIXTURES, 'import-alpha.webp')), { browserDecode: wrongSize }), /decoded .* as 10x10, expected 96x96/);
  });
});

test('importImage writes the master PNG and a wrapper SVG the validator and export accept', async () => {
  await withTemp(async (dir) => {
    const src = writePng(path.join(dir, 'gemini.png'), 300, 300, ringOnBackground(300, WHITE));
    const out = path.join(dir, 'icon-work');
    const result = await importImage({ srcPath: src, outDir: out, name: 'my-app' });
    assert.deepEqual(result.files.map((file) => path.basename(file.path)), ['my-app-master.png', 'my-app-master.svg']);
    const png = decodePng(fs.readFileSync(path.join(out, 'my-app-master.png')));
    assert.deepEqual([png.width, png.height], [300, 300]);
    assert.deepEqual(analyzeRgba(300, 300, png.rgba).cornerAlphas, [0, 0, 0, 0]);
    const svg = fs.readFileSync(path.join(out, 'my-app-master.svg'), 'utf8');
    const check = validateSvg(svg);
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.deepEqual(check.viewBox, { minX: 0, minY: 0, width: 300, height: 300 });
    assert.equal(isRasterMaster(check.elements), true);
    assert.match(svg, /href="data:image\/png;base64,/);
    const text = describeImport(result).join('\n');
    assert.match(text, /PNG, 300x300 px/);
    assert.match(text, /Corner alpha: before \[255 255 255 255\], after \[0 0 0 0\]/);
    assert.match(text, /Made transparent: \d+\.\d%/);
  });
});

test('importImage never overwrites without force and never writes before checks pass', async () => {
  await withTemp(async (dir) => {
    const src = writePng(path.join(dir, 'a.png'), 64, 64, glyphIcon(64));
    const out = path.join(dir, 'icon-work');
    await importImage({ srcPath: src, outDir: out, name: 'a' });
    const before = fs.readFileSync(path.join(out, 'a-master.png'));
    await assert.rejects(importImage({ srcPath: src, outDir: out, name: 'a' }), /already exist.*pass --force to overwrite/);
    assert.deepEqual(fs.readFileSync(path.join(out, 'a-master.png')), before, 'the existing file is untouched');
    await importImage({ srcPath: src, outDir: out, name: 'a', force: true });

    const missingOut = path.join(dir, 'never-created');
    await assert.rejects(importImage({ srcPath: path.join(dir, 'nope.png'), outDir: missingOut, name: 'x' }), /no such file/);
    assert.equal(fs.existsSync(missingOut), false);
    const notImage = path.join(dir, 'notes.txt');
    fs.writeFileSync(notImage, 'hello');
    await assert.rejects(importImage({ srcPath: notImage, outDir: missingOut, name: 'x' }), /not a supported image/);
    assert.equal(fs.existsSync(missingOut), false);
  });
});

test('importImage validates its options and the name', async () => {
  await withTemp(async (dir) => {
    const src = writePng(path.join(dir, 'a.png'), 64, 64, glyphIcon(64));
    const out = path.join(dir, 'o');
    await assert.rejects(importImage({ srcPath: src, outDir: out, name: '../escape' }), /not a safe file name/);
    await assert.rejects(importImage({ srcPath: src, outDir: out, name: 'a', background: 'purple' }), /--background must be one of/);
    await assert.rejects(importImage({ srcPath: src, outDir: out, name: 'a', tolerance: 500 }), /--tolerance must be a number from 0 to 120/);
    const tiny = writePng(path.join(dir, 'tiny.png'), 8, 8, glyphIcon(8));
    await assert.rejects(importImage({ srcPath: tiny, outDir: out, name: 'a' }), /at least 16 px/);
    assert.equal(fs.existsSync(out), false);
  });
});

test('importImage works through a link in the named paths (macOS /var) and writes to the real folder', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    writePng(path.join(real, 'a.png'), 64, 64, glyphIcon(64));
    const result = await importImage({ srcPath: path.join(linked, 'a.png'), outDir: path.join(linked, 'icons', 'icon-work'), name: 'a' });
    assert.deepEqual(fs.readdirSync(path.join(real, 'icons', 'icon-work')).sort(), ['a-master.png', 'a-master.svg']);
    assert.ok(result.files.every((file) => !file.path.split(path.sep).includes('alias')), 'the reported files are in the real folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('importImage refuses to write through a link planted inside the current folder', { skip: dirLinkSkipReason }, async () => {
  const { base, real } = makeAliasedTemp();
  try {
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    const src = writePng(path.join(project, 'a.png'), 64, 64, glyphIcon(64));
    makeDirLink(real, path.join(project, 'icon-work'));
    await withCwd(project, async () => {
      await assert.rejects(
        importImage({ srcPath: src, outDir: path.join(project, 'icon-work'), name: 'a' }),
        /icon-work is a symbolic link or junction inside the current folder/,
      );
      await assert.rejects(importImage({ srcPath: src, outDir: 'icon-work', name: 'a' }), /inside the current folder/);
    });
    assert.deepEqual(fs.readdirSync(real), [], 'nothing was written through the link');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an SVG source is validated and copied unchanged; an unsafe one is refused', async () => {
  await withTemp(async (dir) => {
    const out = path.join(dir, 'icon-work');
    const good = path.join(dir, 'good.svg');
    fs.writeFileSync(good, fs.readFileSync(path.join(FIXTURES, 'terminal.svg')));
    const result = await importImage({ srcPath: good, outDir: out, name: 'term' });
    assert.equal(result.kind, 'svg');
    assert.deepEqual(fs.readFileSync(path.join(out, 'term-master.svg')), fs.readFileSync(good));
    assert.equal(fs.existsSync(path.join(out, 'term-master.png')), false, 'an SVG needs no raster master');

    const evil = path.join(dir, 'evil.svg');
    fs.writeFileSync(evil, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script></svg>');
    await assert.rejects(importImage({ srcPath: evil, outDir: path.join(dir, 'o2'), name: 'evil' }), /cannot be used:[\s\S]*script/);
    // The wrapper rule is unchanged: SVG hidden in a data: URL is still refused.
    const nested = path.join(dir, 'nested.svg');
    fs.writeFileSync(nested, wrapperSvg(Buffer.from('x'), 64).replace('image/png', 'image/svg+xml'));
    await assert.rejects(importImage({ srcPath: nested, outDir: path.join(dir, 'o3'), name: 'nested' }), /not a supported raster image/);
  });
});

test('cornerPixels reads the four corners in a fixed order', () => {
  const rgba = canvas(3, 2, [0, 0, 0, 0]);
  setPixel(rgba, 3, 0, 0, [1, 0, 0, 255]);
  setPixel(rgba, 3, 2, 0, [2, 0, 0, 255]);
  setPixel(rgba, 3, 0, 1, [3, 0, 0, 255]);
  setPixel(rgba, 3, 2, 1, [4, 0, 0, 255]);
  assert.deepEqual(cornerPixels(rgba, 3, 2).map((corner) => corner.r), [1, 2, 3, 4]);
});

test('a PNG the built-in codec cannot read (16-bit, interlaced) falls back to the browser', async () => {
  await withTemp(async (dir) => {
    const asked = [];
    const fake = async (request) => {
      asked.push(path.basename(request.imagePath));
      return { width: request.width, height: request.height, rgba: canvas(request.width, request.height, [5, 6, 7, 255]) };
    };
    const sixteen = path.join(dir, 'deep.png');
    fs.writeFileSync(sixteen, makePng16(20, 20, [200, 30, 30, 255]));
    const deep = await decodeSource(loadSource(sixteen), { browserDecode: fake });
    assert.equal(deep.via, 'browser');

    const interlaced = Buffer.from(encodePng(20, 20, canvas(20, 20, [1, 1, 1, 255])));
    interlaced[28] = 1; // IHDR interlace method byte: Adam7
    const interlacedFile = path.join(dir, 'adam7.png');
    fs.writeFileSync(interlacedFile, interlaced);
    const adam7 = await decodeSource(loadSource(interlacedFile), { browserDecode: fake });
    assert.equal(adam7.via, 'browser');
    assert.deepEqual(asked, ['deep.png', 'adam7.png']);

    // A corrupt PNG is an error, not a browser fallback.
    const broken = Buffer.from(encodePng(20, 20, canvas(20, 20, [1, 1, 1, 255])));
    broken.fill(0, 60, 80);
    const brokenFile = path.join(dir, 'broken.png');
    fs.writeFileSync(brokenFile, broken);
    await assert.rejects(decodeSource(loadSource(brokenFile), { browserDecode: fake }), /is not a readable PNG/);
    assert.equal(asked.length, 2, 'the browser was not asked about the corrupt file');
  });
});

test('very large sources are brought to the working size before any pixel work', async () => {
  await withTemp(async (dir) => {
    const src = writePng(path.join(dir, 'wide.png'), 3000, 1000, canvas(3000, 1000, [30, 41, 120, 255]));
    const decoded = await decodeSource(loadSource(src), { browserDecode: null });
    assert.deepEqual([decoded.width, decoded.height], [2048, 683], 'longer side capped at 2048 px');
    assert.deepEqual(getPixel(decoded.rgba, 2048, 1000, 300), [30, 41, 120, 255]);

    const out = path.join(dir, 'icon-work');
    const result = await importImage({ srcPath: src, outDir: out, name: 'wide', background: 'keep' });
    assert.equal(result.facts.sourceWidth, 3000, 'the facts name the real source size');
    assert.equal(result.master.size, 1024);
    assert.match(describeImport(result).join('\n'), /shrunk from 3000x1000/);
  });
});
