// Tests of ingest: a folder of the user's own pictures taken in as numbered candidates of a run folder, which pack.mjs
// then builds into packs and contact sheets. Synthetic pictures in temporary folders only; no network, no browser
// (a stand-in decoder plays the browser where one is needed).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ingestFolder, naturalOrder, MAX_CANDIDATES, LIST_LIMIT } from '../scripts/lib/ingest.mjs';
import { readRunRecords } from '../scripts/lib/runrecords.mjs';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';
import { FIXTURES, makeGif, makeBmp, linkSkipReason } from './import-helpers.mjs';
import { makeDirLink, dirLinkSkipReason } from './helpers.mjs';
import { candidateTile } from './pixel-helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

const PACK = path.resolve('scripts/pack.mjs');

function runPack(args) {
  const result = spawnSync(process.execPath, [PACK, ...args], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A picture of `size` px: a coloured tile on white, a different colour for every `seed`, so no two share their bytes. */
function picture(size, seed) {
  return candidateTile(size, { tile: [(40 + seed * 37) % 256, (120 + seed * 53) % 256, (246 + seed * 71) % 256] });
}

/** A two-frame GIF of `size` px: a red square on white. */
function animatedGif(size) {
  const indices = Array.from({ length: size * size }, (_, i) => {
    const x = i % size;
    const y = Math.floor(i / size);
    return x > size / 4 && x < (size * 3) / 4 && y > size / 4 && y < (size * 3) / 4 ? 1 : 0;
  });
  return makeGif({ width: size, height: size, palette: [[255, 255, 255], [200, 30, 30], [0, 0, 0], [0, 0, 0]], indices, frames: 2 });
}

function folderWith(files) {
  const dir = makeTmpDir('icon-creator-pictures-');
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes === null) fs.mkdirSync(path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

/** Name -> content hash and modification time of every entry, to prove the pictures were not touched. */
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return [name, stat.isFile() ? `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')} ${stat.mtimeMs}` : 'folder'];
  }));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('naturalOrder puts img2 before img10 and breaks ties by the exact name', () => {
  assert.deepEqual(['img10.png', 'img2.png', 'img1.png', 'IMG1.png'].sort(naturalOrder), ['IMG1.png', 'img1.png', 'img2.png', 'img10.png']);
});

test('ingest takes the pictures in natural name order as candidate-1..n and records where each came from', async () => {
  const files = {
    'img10.png': picture(200, 1),
    'img2.png': picture(150, 2),
    'img1.jpg': fs.readFileSync(path.join(FIXTURES, 'import-white.jpg')),
    'anim.gif': animatedGif(80),
    'アイコン 最終.png': picture(128, 3),
    'logo final.png': picture(100, 4),
  };
  const pictures = folderWith(files);
  const before = snapshot(pictures);
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });

  const order = ['anim.gif', 'img1.jpg', 'img2.png', 'img10.png', 'logo final.png', 'アイコン 最終.png'];
  assert.deepEqual(result.added.map((added) => added.source), order);
  assert.deepEqual(result.added.map((added) => added.candidate), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.batch, 1);
  assert.equal(result.run, run);
  const byName = Object.fromEntries(result.added.map((added) => [added.source, added]));
  assert.equal(byName['img1.jpg'].decodedBy, 'built-in JPEG decoder');
  assert.equal(byName['anim.gif'].decodedBy, 'built-in GIF decoder');
  assert.equal(byName['anim.gif'].note, 'animated GIF: only the first frame is used');
  assert.equal(byName['img10.png'].decodedBy, 'built-in PNG codec');
  assert.equal(byName['img2.png'].stored, '150x150', 'a picture up to 1024 px is stored at its own size');

  for (const added of result.added) {
    const stored = decodePng(fs.readFileSync(path.join(run, added.file)));
    assert.equal(`${stored.width}x${stored.height}`, added.stored);
  }
  const record = readJson(path.join(run, 'run.json'));
  assert.equal(record.plugin, 'icon-creator');
  assert.equal(record.batches.length, 1);
  assert.equal(record.batches[0].source, 'folder');
  assert.equal(record.batches[0].folder, pictures);
  assert.deepEqual(record.batches[0].candidates, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(record.candidates.map((candidate) => candidate.source), order);
  for (const candidate of record.candidates) {
    const original = fs.readFileSync(path.join(pictures, candidate.source));
    assert.equal(candidate.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  }
  const records = readRunRecords(run);
  assert.equal(records.nextIndex, 7);
  assert.equal(records.nextBatch, 2);
  assert.deepEqual(snapshot(pictures), before, 'the pictures are only read: not changed, moved or deleted');
});

test('ingest skips what is not a usable picture and says why; hidden and system files and subfolders are only listed', async () => {
  const good = picture(128, 5);
  const pictures = folderWith({
    'good.png': good,
    'same.png': good,
    'tiny.png': picture(40, 6),
    'notes.txt': Buffer.from('not a picture'),
    'logo.svg': fs.readFileSync(path.join(FIXTURES, 'clock.svg')),
    'photo.webp': fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp')),
    'Thumbs.db': Buffer.from('cache'),
    '.hidden.png': picture(128, 7),
    sub: null,
  });
  fs.writeFileSync(path.join(pictures, 'sub', 'inside.png'), picture(128, 8));
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });

  assert.deepEqual(result.added.map((added) => added.source), ['good.png']);
  const reasons = Object.fromEntries(result.skipped.map((skipped) => [skipped.file, skipped.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), ['logo.svg', 'notes.txt', 'photo.webp', 'same.png', 'tiny.png']);
  assert.match(reasons['same.png'], /the same picture as good\.png/);
  assert.match(reasons['tiny.png'], /40x40 px is too small/);
  assert.match(reasons['notes.txt'], /^the file is not a supported image/);
  assert.match(reasons['logo.svg'], /already a drawing/);
  assert.match(reasons['photo.webp'], /needs a headless browser/);
  assert.ok(!Object.values(reasons).some((reason) => reason.includes(pictures)), 'reasons name "the file", not the absolute path');
  assert.deepEqual([...result.ignored].sort(), ['.hidden.png', 'Thumbs.db']);
  assert.deepEqual(result.subfolders, ['sub']);
  assert.deepEqual(readJson(path.join(run, 'run.json')).batches[0].skipped, result.skipped, 'the record keeps the reasons too');
});

test('WebP and BMP are taken in through the browser decoder when one is given', async () => {
  const pictures = folderWith({
    'photo.webp': fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp')),
    'scan.bmp': makeBmp(100, 80, () => [10, 200, 30]),
  });
  const asked = [];
  const browserDecode = async ({ imagePath, width, height }) => {
    asked.push(path.basename(imagePath));
    return { width, height, rgba: Buffer.alloc(width * height * 4, 200) };
  };
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run, browserDecode });
  assert.deepEqual(asked, ['photo.webp', 'scan.bmp']);
  assert.deepEqual(result.added.map((added) => [added.source, added.format, added.decodedBy, added.stored]), [
    ['photo.webp', 'webp', 'browser', '96x96'],
    ['scan.bmp', 'bmp', 'browser', '100x80'],
  ]);
});

test('--max takes the first pictures; ingest again adds the rest after the others, then only what is new', async () => {
  const pictures = folderWith(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`p${n}.png`, picture(96, 10 + n)])));
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');

  const first = await ingestFolder({ from: pictures, run, max: 2 });
  assert.deepEqual(first.added.map((added) => added.source), ['p1.png', 'p2.png']);
  assert.deepEqual(first.notTaken, ['p3.png', 'p4.png', 'p5.png']);
  assert.equal(readJson(path.join(run, 'run.json')).batches[0].notTaken, 3);
  const runJson = fs.readFileSync(path.join(run, 'run.json'));

  const second = await ingestFolder({ from: pictures, run });
  assert.deepEqual(second.already, [{ file: 'p1.png', candidate: 1 }, { file: 'p2.png', candidate: 2 }]);
  assert.deepEqual(second.added.map((added) => [added.source, added.candidate]), [['p3.png', 3], ['p4.png', 4], ['p5.png', 5]]);
  assert.equal(second.batch, 2);
  const batch = readJson(path.join(run, 'batch-2.json'));
  assert.equal(batch.plugin, 'icon-creator');
  assert.deepEqual(batch.batch.candidates, [3, 4, 5]);
  assert.deepEqual(fs.readFileSync(path.join(run, 'run.json')), runJson, 'run.json stays as it was written');

  fs.writeFileSync(path.join(pictures, 'p6.png'), picture(96, 16));
  const third = await ingestFolder({ from: pictures, run });
  assert.deepEqual(third.added.map((added) => [added.source, added.candidate]), [['p6.png', 6]]);
  assert.equal(third.batch, 3);

  const nothing = await ingestFolder({ from: pictures, run });
  assert.deepEqual(nothing.added, []);
  assert.equal(nothing.already.length, 6);
  assert.equal(nothing.batch, null);
  assert.ok(!fs.existsSync(path.join(run, 'batch-4.json')), 'nothing new: no record is written');
  const records = readRunRecords(run);
  assert.deepEqual(records.run.candidates.map((candidate) => candidate.index), [1, 2, 3, 4, 5, 6]);
});

test('a picture larger than 1024 px is stored shrunk to 1024 px on its longer side', async () => {
  const width = 1500;
  const height = 1000;
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let y = 300; y < 700; y += 1) rgba.fill(0, (y * width + 500) * 4, (y * width + 1000) * 4);
  const pictures = folderWith({ 'wide.png': encodePng(width, height, rgba) });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });
  assert.equal(result.added[0].size, '1500x1000');
  assert.equal(result.added[0].stored, '1024x683');
  const stored = decodePng(fs.readFileSync(path.join(run, 'candidate-1.png')));
  assert.deepEqual([stored.width, stored.height], [1024, 683]);
});

test('the run folder must be new, empty or made by ingest, and never the picture folder itself', async () => {
  const pictures = folderWith({ 'a.png': picture(96, 20) });
  const base = makeTmpDir('icon-creator-run-');
  await assert.rejects(ingestFolder({ from: pictures, run: pictures }), /must not be the folder of the pictures/);
  const foreign = path.join(base, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'report.docx'), 'x');
  await assert.rejects(ingestFolder({ from: pictures, run: foreign }), /not empty and is not a run folder made by this plugin/);
  const broken = path.join(base, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'run.json'), '{');
  await assert.rejects(ingestFolder({ from: pictures, run: broken }), /cannot be used: .*not valid JSON/);
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'run.json'), JSON.stringify({ plugin: 'someone-else', candidates: [] }));
  await assert.rejects(ingestFolder({ from: pictures, run: other }), /cannot be used: .*not a run folder made by this plugin/);
  const asFile = path.join(base, 'a-file');
  fs.writeFileSync(asFile, 'x');
  await assert.rejects(ingestFolder({ from: pictures, run: asFile }), /exists and is not a folder/);
  for (const name of ['report.docx']) assert.ok(fs.existsSync(path.join(foreign, name)), 'a refused folder is left as it was');
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  const result = await ingestFolder({ from: pictures, run: empty });
  assert.deepEqual(result.added.map((added) => added.file), ['candidate-1.png']);
});

test('ingest refuses a picture folder that is missing or a file, and a bad --max, before anything is written', async () => {
  const base = makeTmpDir('icon-creator-run-');
  const run = path.join(base, 'run');
  await assert.rejects(ingestFolder({ from: path.join(base, 'missing'), run }), /does not exist/);
  const file = path.join(base, 'one.png');
  fs.writeFileSync(file, picture(96, 21));
  await assert.rejects(ingestFolder({ from: file, run }), /is not a folder: .*icons\.mjs import/);
  const pictures = folderWith({ 'a.png': picture(96, 22) });
  for (const max of [0, MAX_CANDIDATES + 1, 1.5, Number.NaN]) {
    await assert.rejects(ingestFolder({ from: pictures, run, max }), /--max must be a whole number from 1 to 64/);
  }
  assert.ok(!fs.existsSync(run), 'no run folder is created by a refused call');
});

test('nothing is created when no picture can be taken in', async () => {
  const pictures = folderWith({ 'notes.txt': Buffer.from('no pictures here'), 'tiny.png': picture(32, 23) });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });
  assert.deepEqual(result.added, []);
  assert.equal(result.skipped.length, 2);
  assert.ok(!fs.existsSync(run));
});

test('a run folder holding only candidate files (its record was never written) is continued after them', async () => {
  const run = makeTmpDir('icon-creator-run-');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), picture(96, 30));
  fs.writeFileSync(path.join(run, 'candidate-2.png'), picture(96, 31));
  const pictures = folderWith({ 'mine.png': picture(96, 32) });
  const result = await ingestFolder({ from: pictures, run });
  assert.deepEqual(result.added.map((added) => added.file), ['candidate-3.png']);
  assert.match(result.recordProblems.join('\n'), /holds candidate files but no run\.json/);
  assert.equal(result.batch, 1);
  const records = readRunRecords(run);
  assert.deepEqual(records.run.candidates.map((candidate) => candidate.index), [3]);
  assert.equal(records.nextIndex, 4);
  fs.writeFileSync(path.join(run, 'notes.txt'), 'x');
  const foreign = makeTmpDir('icon-creator-run-');
  fs.writeFileSync(path.join(foreign, 'candidate-1.png'), picture(96, 33));
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x');
  await assert.rejects(ingestFolder({ from: pictures, run: foreign }), /not empty and is not a run folder made by this plugin/);
});

test('a run folder of another plugin, even one with a similar name, is refused', async () => {
  const run = makeTmpDir('icon-creator-run-');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), picture(96, 34));
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ plugin: 'icon-creator-x', batches: [], candidates: [] }));
  const pictures = folderWith({ 'mine.png': picture(96, 35) });
  await assert.rejects(ingestFolder({ from: pictures, run }), /cannot be used: .*not a run folder made by this plugin/);
});

test('a damaged batch record is reported, kept, and never overwritten by the next one', async () => {
  const pictures = folderWith({ 'a.png': picture(96, 40) });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  await ingestFolder({ from: pictures, run });
  fs.writeFileSync(path.join(run, 'batch-2.json'), 'damaged');
  fs.writeFileSync(path.join(pictures, 'b.png'), picture(96, 41));
  const result = await ingestFolder({ from: pictures, run });
  assert.match(result.recordProblems.join('\n'), /batch-2\.json is not valid JSON/);
  assert.equal(result.batch, 3);
  assert.deepEqual(result.added.map((added) => added.file), ['candidate-2.png']);
  assert.equal(fs.readFileSync(path.join(run, 'batch-2.json'), 'utf8'), 'damaged');
  assert.equal(readJson(path.join(run, 'batch-3.json')).batch.number, 3);
});

test('pack.mjs ingest, build and sheet work together on a folder of pictures, round after round', () => {
  const pictures = folderWith({ 'one.png': picture(256, 50), 'two.png': picture(256, 51), 'three.jpg': fs.readFileSync(path.join(FIXTURES, 'import-white.jpg')) });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');

  const ingest = runPack(['ingest', '--from', pictures, '--run', run]);
  assert.equal(ingest.code, 0, ingest.stderr);
  const taken = JSON.parse(ingest.stdout);
  assert.deepEqual(taken.added.map((added) => added.source), ['one.png', 'three.jpg', 'two.png']);

  const build = runPack(['build', '--run', run, '--name', 'demo']);
  assert.equal(build.code, 0, build.stderr);
  const summary = JSON.parse(build.stdout);
  assert.deepEqual(summary.packs.map((pack) => pack.candidate), [1, 2, 3]);
  assert.deepEqual(Object.keys(summary.packs[0]), ['candidate', 'pack', 'master', 'warnings', 'omitted', 'svgFit']);
  assert.ok(Object.keys(summary).indexOf('skipped') < Object.keys(summary).indexOf('packs'), 'what was skipped comes first');
  assert.ok(build.stdout.length < 400 * 3 + 600, `the summary stays short: ${build.stdout.length} characters`);
  const detail = readJson(path.join(run, summary.detail));
  assert.equal(summary.detail, 'build-1.json');
  assert.deepEqual(detail.packs.map((pack) => pack.candidate), [1, 2, 3]);
  assert.ok(detail.packs[0].facts.svgFit.reasons.length >= 0 && detail.packs[0].files.length > 10, 'the detail file has the facts and files');
  assert.ok(fs.existsSync(path.join(run, 'pack-1', 'windows', 'demo.ico')));
  const sheet = runPack(['sheet', '--run', run]);
  assert.equal(sheet.code, 0, sheet.stderr);
  assert.ok(fs.existsSync(path.join(run, 'sheet-1.png')));

  fs.writeFileSync(path.join(pictures, 'four.png'), picture(256, 52));
  const again = runPack(['ingest', '--from', pictures, '--run', run]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).added.map((added) => added.candidate), [4]);
  const buildNew = runPack(['build', '--run', run, '--only', '4']);
  assert.equal(buildNew.code, 0, buildNew.stderr);
  assert.equal(JSON.parse(buildNew.stdout).detail, 'build-2.json', 'every build keeps its own detail file');
  assert.ok(fs.existsSync(path.join(run, 'pack-4', 'windows', 'demo.ico')), 'the pack name of the run is reused');
  const sheetNew = runPack(['sheet', '--run', run, '--only', '4']);
  assert.equal(sheetNew.code, 0, sheetNew.stderr);
  assert.ok(fs.existsSync(path.join(run, 'sheet-2.png')));

  const nothing = runPack(['ingest', '--from', pictures, '--run', run]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /nothing new to take in: 4 pictures of that folder are already in this run/);
});

test('pack.mjs ingest checks its options', () => {
  const pictures = folderWith({ 'a.png': picture(96, 60) });
  const empty = folderWith({ 'notes.txt': Buffer.from('nothing') });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const cases = [
    [['ingest', '--run', run], /ingest needs --from/],
    [['build', '--run', run, '--from', pictures], /--from and --max belong to ingest/],
    [['ingest', '--from', pictures, '--run', run, '--max', '0'], /--max must be a whole number from 1 to 64/],
    [['ingest', '--from', pictures, '--run', run, '--fill', '90'], /ingest takes only --from, --run and --max \(not --fill\)/],
    [['ingest', '--from', empty, '--run', run], /no picture could be taken in/],
  ];
  for (const [args, message] of cases) {
    const { code, stderr } = runPack(args);
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, message);
  }
  assert.ok(!fs.existsSync(run));
});

test('ingest follows a link outside the current folder once, for the pictures and the run folder, and says so', { skip: dirLinkSkipReason }, async () => {
  const base = makeTmpDir('icon-creator-links-');
  const realPictures = path.join(base, 'real-pictures');
  fs.mkdirSync(realPictures);
  fs.writeFileSync(path.join(realPictures, 'a.png'), picture(96, 70));
  fs.mkdirSync(path.join(base, 'real-runs'));
  makeDirLink(realPictures, path.join(base, 'pictures-link'));
  makeDirLink(path.join(base, 'real-runs'), path.join(base, 'runs-link'));
  const notes = [];
  const result = await ingestFolder({ from: path.join(base, 'pictures-link'), run: path.join(base, 'runs-link', 'run'), onNote: (line) => notes.push(line) });
  assert.equal(result.from, realPictures);
  assert.equal(result.run, path.join(base, 'real-runs', 'run'));
  assert.deepEqual(result.added.map((added) => added.file), ['candidate-1.png']);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^Note: The picture folder .*pictures-link goes through a symbolic link or junction; using its real location .*real-pictures\.$/);
  assert.match(notes[1], /^Note: The run folder .*runs-link.run goes through a symbolic link or junction; using its real location .*real-runs.run\.$/);
  // build, typed through the same link, works on the same folder (its own test is in pack.test.mjs)
  const build = runPack(['build', '--run', path.join(base, 'runs-link', 'run')]);
  assert.equal(build.code, 0, build.stderr);
  assert.match(build.stderr, /^Note: The run folder /m);
});

test('ingest refuses a link inside the current folder, for the pictures and for the run folder', { skip: dirLinkSkipReason }, () => {
  const project = makeTmpDir('icon-creator-project-');
  const pictures = folderWith({ 'a.png': picture(96, 71) });
  makeDirLink(pictures, path.join(project, 'pics'));
  const elsewhere = makeTmpDir('icon-creator-run-');
  makeDirLink(elsewhere, path.join(project, 'runs'));
  const run = (args) => spawnSync(process.execPath, [PACK, ...args], { cwd: project, encoding: 'utf8', windowsHide: true });
  const fromLink = run(['ingest', '--from', 'pics', '--run', 'out']);
  assert.equal(fromLink.status, 1);
  assert.match(fromLink.stderr, /pics is a symbolic link or junction inside the current folder .*refusing to read through it/);
  const runLink = run(['ingest', '--from', pictures, '--run', path.join('runs', 'out')]);
  assert.equal(runLink.status, 1);
  assert.match(runLink.stderr, /runs is a symbolic link or junction inside the current folder .*refusing to write through it/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the refused link');
});

test('a picture that is itself a link is skipped, never followed', { skip: linkSkipReason }, async () => {
  const outside = makeTmpDir('icon-creator-outside-');
  fs.writeFileSync(path.join(outside, 'other-logo.png'), picture(96, 72));
  const pictures = folderWith({ 'real.png': picture(96, 73) });
  fs.symlinkSync(path.join(outside, 'other-logo.png'), path.join(pictures, 'linked.png'));
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });
  assert.deepEqual(result.added.map((added) => added.source), ['real.png']);
  assert.deepEqual(result.skipped, [{ file: 'linked.png', reason: 'a symbolic link or junction: not followed' }]);
});

test('a text file that starts with "<" is not taken for an SVG; a real SVG is sent to file mode', async () => {
  const pictures = folderWith({
    'page.html': Buffer.from('<html><body>hi</body></html>'),
    'logo.svg': fs.readFileSync(path.join(FIXTURES, 'clock.svg')),
    'ok.png': picture(96, 74),
  });
  const result = await ingestFolder({ from: pictures, run: path.join(makeTmpDir('icon-creator-run-'), 'run') });
  const reasons = Object.fromEntries(result.skipped.map((skipped) => [skipped.file, skipped.reason]));
  assert.match(reasons['page.html'], /^the file is not a supported image/);
  assert.match(reasons['logo.svg'], /an SVG is already a drawing/);
});

test('of a file that is not a picture only the first bytes are read: a huge text file is skipped as not a picture', async () => {
  const pictures = folderWith({ 'ok.png': picture(96, 75) });
  // 26 MB is over the 25 MB a picture may have: had the file been read as a picture, the reason would be its size.
  fs.writeFileSync(path.join(pictures, 'huge.log'), Buffer.alloc(26 * 1024 * 1024, 'a'));
  const result = await ingestFolder({ from: pictures, run: path.join(makeTmpDir('icon-creator-run-'), 'run') });
  assert.deepEqual(result.skipped.map((skipped) => skipped.file), ['huge.log']);
  assert.match(result.skipped[0].reason, /^the file is not a supported image/);
});

test('a folder of thousands of files keeps the output and the record short: lists are cut, counts are complete', async () => {
  const files = { 'ok.png': picture(96, 76) };
  for (let n = 1; n <= LIST_LIMIT + 10; n += 1) files[`note-${n}.txt`] = Buffer.from(`note ${n}`);
  const pictures = folderWith(files);
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  const result = await ingestFolder({ from: pictures, run });
  assert.equal(result.counts.skipped, LIST_LIMIT + 10);
  assert.equal(result.skipped.length, LIST_LIMIT);
  assert.equal(result.counts.added, 1);
  const batch = readJson(path.join(run, 'run.json')).batches[0];
  assert.equal(batch.skipped.length, LIST_LIMIT);
  assert.equal(batch.skippedCount, LIST_LIMIT + 10);
});

test('a write that fails half way leaves the candidates written so far recorded, and the next call continues', async () => {
  const pictures = folderWith({ 'p1.png': picture(96, 80), 'p2.png': picture(96, 81), 'p3.png': picture(96, 82) });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  let writes = 0;
  const failingPublish = (target, buffer) => {
    writes += 1;
    if (path.basename(target) === 'candidate-2.png') throw new Error('no space left on device');
    fs.writeFileSync(target, buffer);
  };
  await assert.rejects(ingestFolder({ from: pictures, run, publish: failingPublish }),
    /writing candidate-2\.png failed \(no space left on device\); candidates 1 to 1 were written and recorded\. Run ingest again for the rest\./);
  assert.deepEqual(fs.readdirSync(run).sort(), ['candidate-1.png', 'run.json']);
  assert.deepEqual(readJson(path.join(run, 'run.json')).candidates.map((candidate) => candidate.source), ['p1.png']);
  const again = await ingestFolder({ from: pictures, run });
  assert.deepEqual(again.already, [{ file: 'p1.png', candidate: 1 }]);
  assert.deepEqual(again.added.map((added) => [added.source, added.candidate]), [['p2.png', 2], ['p3.png', 3]]);
  assert.ok(writes >= 2);
});

test('a candidate file that appears while the pictures are read stops the call before anything is written', async () => {
  const run = makeTmpDir('icon-creator-run-');
  const pictures = folderWith({ 'photo.webp': fs.readFileSync(path.join(FIXTURES, 'import-alpha.webp')) });
  const browserDecode = async ({ width, height }) => {
    fs.writeFileSync(path.join(run, 'candidate-1.png'), picture(96, 83)); // another process got there first
    return { width, height, rgba: Buffer.alloc(width * height * 4, 200) };
  };
  await assert.rejects(ingestFolder({ from: pictures, run, browserDecode }), /candidate-1\.png appeared while the pictures were read; nothing was written/);
  assert.deepEqual(fs.readdirSync(run), ['candidate-1.png']);
});

test('pack.mjs ingest with nothing new says so even when the folder also holds files that are not pictures', () => {
  const pictures = folderWith({ 'a.png': picture(96, 84), 'readme.txt': Buffer.from('not a picture') });
  const run = path.join(makeTmpDir('icon-creator-run-'), 'run');
  assert.equal(runPack(['ingest', '--from', pictures, '--run', run]).code, 0);
  const again = runPack(['ingest', '--from', pictures, '--run', run]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /nothing new to take in: 1 picture of that folder is already in this run \(1 file is not a usable picture: see "skipped"\)/);
});
