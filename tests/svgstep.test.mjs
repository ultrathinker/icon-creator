// The SVG step: measuring a master by numbers, comparing a drawing with it, the pack files an SVG adds, and (when this machine has
// a browser or another renderer) the whole command-line round trip with a real drawing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { measureMaster, compareToMaster, findRenderer, runsOf } from '../scripts/lib/svgstep.mjs';
import { discoverRenderers } from '../scripts/lib/renderers.mjs';
import { planPack, headHtmlText, buildPack, prepareCandidate } from '../scripts/lib/packbuild.mjs';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';
import { makeTmpDir } from './tmp.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SVG = path.join(ROOT, 'scripts', 'svg.mjs');
const SIZE = 256;

const BLACK = [14, 14, 14];
const YELLOW = [251, 204, 13];
const WHITE = [255, 255, 255];
const LAVENDER = [220, 220, 240];

/** A transparent square with a picture drawn by `paint(x, y, distance)` (null = clear). */
function draw(paint, size = SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = paint(x + 0.5, y + 0.5, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
      if (colour !== null) rgba.set([...colour, 255], (y * size + x) * 4);
    }
  }
  return rgba;
}

/** A black ring, a white face with a yellow band across it and a lavender eye blob: three flat colours and a blob near white. */
const bee = () =>
  draw((x, y, d) => {
    if (d > 100) return null;
    if (d > 88) return BLACK;
    if (Math.hypot(x - 100, y - 100) < 14) return LAVENDER;
    return y > 120 && y < 150 ? YELLOW : WHITE;
  });

test('measureMaster: size, shape box, the three flat colours with area, box and centre', () => {
  const measured = measureMaster({ size: SIZE, rgba: bee() });
  assert.equal(measured.viewBox, `0 0 ${SIZE} ${SIZE}`);
  assert.equal(measured.shape.x0, 28);
  assert.equal(measured.shape.x1, 227);
  assert.ok(measured.shape.mirrorOverlapPercent > 95, 'the ring is mirror-symmetric');
  const hexes = measured.palette.map((entry) => entry.hex);
  assert.ok(hexes.length >= 3 && hexes.length <= 4, `palette ${hexes.join(' ')}`);
  const nearest = (colour) => measured.palette.find((entry) => Math.hypot(...colour.map((v, i) => v - parseInt(entry.hex.slice(1 + 2 * i, 3 + 2 * i), 16))) < 12);
  for (const colour of [BLACK, YELLOW, WHITE]) assert.ok(nearest(colour) !== undefined, `${colour} is in the palette`);
  assert.equal(measured.palette[0].letter, 'A');
  assert.ok(measured.palette.every((entry, i, all) => i === 0 || all[i - 1].sharePercent >= entry.sharePercent), 'biggest area first');
  const yellow = nearest(YELLOW);
  assert.ok(yellow.box.y0 >= 118 && yellow.box.y1 <= 152, `the yellow band lies between y 120 and 150 (${JSON.stringify(yellow.box)})`);
  assert.ok(Math.abs(yellow.centre.y - 135) < 4);
});

test('measureMaster: the soft edge between two colours is not a palette colour, a blob of a pale colour is', () => {
  const soft = draw((x, y, d) => {
    if (d > 100) return null;
    const t = Math.max(0, Math.min(1, (d - 70) / 8)); // black to white over 8 px: a soft edge, many grey shades
    return BLACK.map((v, i) => Math.round(v * (1 - t) + WHITE[i] * t));
  });
  const greys = measureMaster({ size: SIZE, rgba: soft }).palette;
  assert.ok(greys.length <= 2, `only black and white, not their blends (${greys.map((e) => e.hex).join(' ')})`);
  const withBlob = measureMaster({ size: SIZE, rgba: bee() }).palette;
  assert.ok(withBlob.some((entry) => Math.abs(parseInt(entry.hex.slice(1, 3), 16) - 220) < 14), `the lavender blob stays (${withBlob.map((e) => e.hex).join(' ')})`);
});

test('measureMaster: scanlines are runs of palette letters, soft-edge runs are folded, T is transparent', () => {
  const measured = measureMaster({ size: SIZE, rgba: bee() }, { rows: [128], cols: [128] });
  const row = measured.scanlines.rows['y=128'];
  assert.match(row, /^T0-\d+ [A-Z]\d+-\d+/);
  const runs = row.split(' ').map((run) => /^([A-Z])(\d+)-(\d+)$/.exec(run));
  assert.ok(runs.every((match) => match !== null), row);
  assert.equal(runs[0][1], 'T');
  assert.equal(runs[runs.length - 1][1], 'T');
  for (const match of runs) assert.ok(Number(match[3]) - Number(match[2]) + 1 >= 3, `no run under 3 px in ${row}`);
  for (let i = 1; i < runs.length; i += 1) assert.equal(Number(runs[i][2]), Number(runs[i - 1][3]) + 1, 'the runs follow each other without a gap');
  assert.equal(runs[runs.length - 1][3], String(SIZE - 1), 'the last run reaches the edge');
  assert.ok(measured.scanlines.columns['x=128'] !== undefined);
});

test('runsOf folds a run shorter than 3 px (the soft edge) into its longer neighbour, and keeps long runs', () => {
  const T = -1;
  const row = (values) => runsOf(Int8Array.from(values), values.length, 0, true);
  assert.equal(row([T, T, T, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, T, T, T]), 'T0-2 A3-7 B8-12 T13-15', 'plain runs');
  assert.equal(row([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]), 'A0-10', 'one odd pixel inside a colour is folded away');
  assert.equal(row([0, 0, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1]), 'A0-6 B7-11', 'a 2 px run goes to the neighbour (to the left one when both are as long)');
  assert.equal(row([0, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]), 'A0-3 B4-13', 'and to the longer one when they differ');
  assert.equal(row([1, 1, 1, 1]), 'B0-3');
});

test('measureMaster: with no rows or columns given it samples nine of each inside the shape', () => {
  const measured = measureMaster({ size: SIZE, rgba: bee() });
  assert.equal(Object.keys(measured.scanlines.rows).length, 9);
  assert.equal(Object.keys(measured.scanlines.columns).length, 9);
  const ys = Object.keys(measured.scanlines.rows).map((key) => Number(key.slice(2)));
  assert.ok(ys.every((y) => y >= measured.shape.y0 && y <= measured.shape.y1));
  assert.throws(() => measureMaster({ size: SIZE, rgba: Buffer.alloc(SIZE * SIZE * 4) }), /nothing is visible/);
});

test('compareToMaster: the same picture is a 0 % mismatch and "close"; a moved ring is "off" and the worst blocks say where', () => {
  const master = bee();
  const same = compareToMaster(master, Buffer.from(master), SIZE);
  assert.equal(same.metrics.mismatchPercent, 0);
  assert.equal(same.metrics.verdict, 'close');
  assert.deepEqual(same.metrics.worstBlocks, []);
  const moved = draw((x, y, d) => {
    const shifted = Math.hypot(x - 128 - 40, y - 128);
    if (shifted > 100) return null;
    return shifted > 88 ? BLACK : WHITE;
  });
  const off = compareToMaster(master, moved, SIZE);
  assert.ok(off.metrics.mismatchPercent > 20, `${off.metrics.mismatchPercent}`);
  assert.equal(off.metrics.verdict, 'off');
  assert.ok(off.metrics.worstBlocks.length > 0 && off.metrics.worstBlocks.length <= 6);
  assert.ok(off.metrics.worstBlocks.every((block) => block.mismatchPercentOfBlock >= 1 && typeof block.mostly === 'string'));
  assert.ok(off.metrics.onlyInMasterPercent > 5 && off.metrics.onlyInDrawingPercent > 5);
  const colour = compareToMaster(master, draw((x, y, d) => (d > 100 ? null : d > 88 ? BLACK : [0, 120, 255])), SIZE);
  assert.ok(colour.metrics.colourDiffersPercent > 40, 'the same shape in another colour is a colour mismatch');
  assert.ok(colour.metrics.onlyInMasterPercent < 1 && colour.metrics.onlyInDrawingPercent < 1);
});

test('compareToMaster: a difference within a pixel of an edge is anti-aliasing and does not count; a real one does', () => {
  const master = bee();
  const fatter = draw((x, y, d) => (d > 101 ? null : d > 88 ? BLACK : y > 120 && y < 150 ? YELLOW : WHITE)); // the ring one pixel wider
  const slight = compareToMaster(master, fatter, SIZE);
  assert.ok(slight.metrics.softEdgePercent > 0, 'the one-pixel ring is seen as a soft-edge difference');
  assert.ok(slight.metrics.mismatchPercent < 0.5, `and (all but a few diagonal pixels) not as a mismatch (${slight.metrics.mismatchPercent} %)`);
  assert.equal(slight.metrics.verdict, 'close');
  const bigger = draw((x, y, d) => (d > 112 ? null : d > 100 ? BLACK : y > 120 && y < 150 ? YELLOW : WHITE)); // 12 px wider
  const clear = compareToMaster(master, bigger, SIZE);
  assert.ok(clear.metrics.mismatchPercent > 2, `a ring 12 px wider is a real difference (${clear.metrics.mismatchPercent} %)`);
});

test('compareToMaster: the panel is master | drawing | difference side by side', () => {
  const { panel } = compareToMaster(bee(), bee(), SIZE);
  const decoded = decodePng(panel);
  assert.equal(decoded.height, SIZE);
  assert.equal(decoded.width, 3 * SIZE + 2 * 8);
  // the middle of the left panel is the master's white face on white; the black ring is dark in both of the first two panels
  const at = (x, y) => [...decoded.rgba.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3)];
  assert.deepEqual(at(128 - 95, 128), [...BLACK]);
  assert.deepEqual(at(SIZE + 8 + 128 - 95, 128), [...BLACK]);
  const ghost = at(2 * (SIZE + 8) + 128 - 95, 128);
  assert.ok(ghost[0] > 150 && ghost[0] === ghost[1], 'where both agree the difference panel shows only a pale ghost');
});

test('findRenderer: no renderer gives a plain error that says what to install', () => {
  assert.throws(() => findRenderer(() => ({ chosen: null, candidates: [] })), /The SVG step needs a program that can draw an SVG, and none was found\.\nNo SVG renderer found\.[\s\S]*Install Google Chrome or Microsoft Edge/);
  assert.equal(findRenderer(() => ({ chosen: { name: 'x', kind: 'browser', path: '/x', label: 'X' } })).name, 'x');
});

test('planPack: an SVG adds icon.svg, web/favicon.svg and the scalable Linux icon, and the head snippet links the favicon', () => {
  const plain = planPack('bee', 1024);
  const vector = planPack('bee', 1024, { svg: true });
  assert.ok(!plain.files.some((file) => file.rel.endsWith('.svg')), 'a raster pack has no svg');
  assert.deepEqual(
    vector.files.filter((file) => file.kind === 'svg').map((file) => file.rel),
    ['icon.svg', 'web/favicon.svg', 'linux/hicolor/scalable/apps/bee.svg'],
  );
  assert.equal(vector.files.find((file) => file.rel === 'web/head.html').svg, true);
  assert.match(headHtmlText({ svg: true }), /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.ok(!/favicon\.svg/.test(headHtmlText({})));
  assert.ok(headHtmlText({ svg: true }).indexOf('favicon.svg') < headHtmlText({ svg: true }).indexOf('favicon.ico'), 'the svg link comes first');
});

test('buildPack with an SVG writes the drawing byte for byte', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#fbcc0d"/></svg>\n';
  const prepared = prepareCandidate(encodePng(SIZE, SIZE, bee()), { crop: false });
  const written = new Map();
  buildPack(prepared, { name: 'bee', svg, publish: (rel, buffer) => written.set(rel, buffer) });
  for (const rel of ['icon.svg', 'web/favicon.svg', 'linux/hicolor/scalable/apps/bee.svg']) assert.equal(written.get(rel).toString('utf8'), svg, rel);
  assert.ok(written.has('windows/bee.ico'));
});

// ---- the command-line round trip, with a real renderer when this machine has one

const renderer = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' }).chosen;
const live = { skip: renderer === null ? 'no browser or SVG renderer on this machine' : false };

/** A run folder holding candidate-1.png (a ring with a yellow band, 512 px) and the SVG that draws it on the same grid (the checks pass --no-crop, so the master is the candidate as it is). */
function runWithDrawing(label, svg) {
  const dir = makeTmpDir(`icon-creator-svgstep-${label}-`);
  const size = 512;
  const rgba = draw((x, y, d) => {
    if (d > 200) return null;
    if (d > 176) return BLACK;
    return y > 240 && y < 300 ? YELLOW : WHITE;
  }, size);
  fs.writeFileSync(path.join(dir, 'candidate-1.png'), encodePng(size, size, rgba));
  fs.writeFileSync(path.join(dir, 'svg-1-draft.svg'), svg);
  return dir;
}
const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><clipPath id="c"><circle cx="256" cy="256" r="176"/></clipPath></defs><circle cx="256" cy="256" r="200" fill="#0e0e0e"/><circle cx="256" cy="256" r="176" fill="#fff"/><rect x="0" y="240" width="512" height="60" fill="#fbcc0d" clip-path="url(#c)"/></svg>\n';
const run = async (...args) => JSON.parse((await execFileAsync(process.execPath, [SVG, ...args])).stdout);

test('svg.mjs measure needs no renderer and prints the numbers for a candidate', async () => {
  const dir = runWithDrawing('measure', GOOD);
  const out = await run('measure', '--run', dir, '--number', '1', '--rows', '270', '--cols', '256');
  assert.equal(out.candidate, 1);
  assert.match(out.viewBox, /^0 0 \d+ \d+$/);
  assert.ok(out.palette.length >= 3);
  assert.deepEqual(Object.keys(out.scanlines.rows), ['y=270']);
  assert.deepEqual(Object.keys(out.scanlines.columns), ['x=256']);
});

test('svg.mjs refuses what it cannot use, with a message that names the problem', async () => {
  const dir = runWithDrawing('bad', GOOD);
  const fails = async (args, pattern) => {
    await assert.rejects(execFileAsync(process.execPath, [SVG, ...args]), (error) => pattern.test(error.stderr));
  };
  await fails(['measure', '--run', dir], /--number/);
  await fails(['measure', '--run', dir, '--number', '9'], /no candidate-9/);
  await fails(['check', '--run', dir, '--number', '1'], /--svg/);
  await fails(['measure', '--run', dir, '--number', '1', '--rows', 'a,b'], /whole numbers/);
  fs.writeFileSync(path.join(dir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script></svg>');
  await fails(['check', '--run', dir, '--number', '1', '--svg', path.join(dir, 'evil.svg')], /cannot be used[\s\S]*script/);
  const wrapped = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image width="8" height="8" href="data:image/png;base64,iVBORw0KGgo="/></svg>';
  fs.writeFileSync(path.join(dir, 'wrapped.svg'), wrapped);
  await fails(['check', '--run', dir, '--number', '1', '--svg', path.join(dir, 'wrapped.svg')], /<image> element[\s\S]*not a vector/);
  await fails(['pack', '--run', dir, '--number', '1', '--svg', path.join(dir, 'wrapped.svg')], /<image> element/);
});

test('svg.mjs check draws the SVG, compares it, and writes the comparison picture without overwriting', live, async () => {
  const dir = runWithDrawing('check', GOOD);
  const first = await run('check', '--run', dir, '--number', '1', '--no-crop', '--svg', path.join(dir, 'svg-1-draft.svg'));
  assert.ok(first.metrics.mismatchPercent < 6, `a faithful drawing is close (${first.metrics.mismatchPercent} %)`);
  assert.notEqual(first.metrics.verdict, 'off');
  assert.ok(fs.existsSync(first.picture));
  const second = await run('check', '--run', dir, '--number', '1', '--no-crop', '--svg', path.join(dir, 'svg-1-draft.svg'));
  assert.notEqual(second.picture, first.picture, 'the second check is a new file');
  assert.ok(fs.existsSync(first.picture) && fs.existsSync(second.picture));
  const wrong = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="150" cy="256" r="120" fill="#fbcc0d"/></svg>';
  fs.writeFileSync(path.join(dir, 'wrong.svg'), wrong);
  const bad = await run('check', '--run', dir, '--number', '1', '--no-crop', '--svg', path.join(dir, 'wrong.svg'));
  assert.equal(bad.metrics.verdict, 'off');
  assert.ok(bad.metrics.worstBlocks.length > 0);
});

test('svg.mjs pack builds the full set from the drawing at 1024 px, with the vector files, and never overwrites a pack', live, async () => {
  const dir = runWithDrawing('pack', GOOD);
  const out = await run('pack', '--run', dir, '--number', '1', '--svg', path.join(dir, 'svg-1-draft.svg'), '--name', 'bee', '--title', 'Bee');
  assert.equal(out.masterSize, 1024, 'a vector is drawn at 1024 px whatever size the candidate was');
  assert.equal(path.basename(out.packDir), 'pack-1-svg');
  const rels = out.files.map((file) => file.rel);
  for (const rel of ['icon-1024.png', 'icon.svg', 'web/favicon.svg', 'linux/hicolor/scalable/apps/bee.svg', 'windows/bee.ico', 'macos/bee.icns', 'web/head.html']) assert.ok(rels.includes(rel), `${rel} is in the pack`);
  assert.deepEqual(out.omitted, [], 'a 1024 px master leaves nothing out');
  assert.equal(fs.readFileSync(path.join(out.packDir, 'icon.svg'), 'utf8'), GOOD, 'the drawing is published exactly as drawn');
  const master = decodePng(fs.readFileSync(path.join(out.packDir, 'icon-1024.png')));
  assert.equal(master.rgba[3], 0, 'transparent corners');
  assert.match(fs.readFileSync(path.join(out.packDir, 'web', 'head.html'), 'utf8'), /favicon\.svg/);
  const again = await run('pack', '--run', dir, '--number', '1', '--svg', path.join(dir, 'svg-1-draft.svg'), '--name', 'bee');
  assert.equal(path.basename(again.packDir), 'pack-1-svg-2');
  assert.ok(fs.existsSync(out.packDir), 'the first pack is untouched');
});
