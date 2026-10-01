// CLI-level tests for `import`, run through the real entry point the way the
// skill invokes it. Tests that need a real browser are skipped (with a
// message) when none is installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverRenderers } from '../scripts/lib/renderers.mjs';
import { decodePng, analyzeRgba } from '../scripts/lib/png.mjs';
import { parseIco } from '../scripts/lib/ico.mjs';
import {
  FIXTURES,
  withTemp,
  canvas,
  getPixel,
  ringOnBackground,
  glyphIcon,
  writePng,
  makeBmp,
  makePng16,
} from './import-helpers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
// A real render launches a browser; on a slow CI runner (GitHub's Windows
// image needs ten seconds or more per render) one command can take minutes.
const REAL_RENDER_TIMEOUT_MS = 900000;
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const hasBrowser = discovery.chosen !== null && discovery.chosen.kind === 'browser';
const browserSkip = hasBrowser ? undefined : 'no headless browser on this machine';

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: REAL_RENDER_TIMEOUT_MS });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function masterPng(dir, name) {
  return decodePng(fs.readFileSync(path.join(dir, `${name}-master.png`)));
}

test('import prepares a white-background PNG and prints the measured facts', () => {
  withTemp((dir) => {
    const src = writePng(path.join(dir, 'gemini.png'), 200, 200, ringOnBackground(200, [255, 255, 255, 255]));
    const out = path.join(dir, 'icon-work');
    const { code, stdout, stderr } = runCli(['import', src, '--out', out, '--name', 'ring']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Background: mode auto -> remove/);
    assert.match(stdout, /Corner alpha: before \[255 255 255 255\], after \[0 0 0 0\]/);
    assert.match(stdout, /Made transparent: \d+\.\d% of the pixels/);
    assert.match(stdout, /Fit: already square, 200x200, not resized/);
    assert.match(stdout, /Wrote .*ring-master\.png/);
    assert.match(stdout, /Use .*ring-master\.svg with check, sheet, render and export/);
    assert.match(stdout, /\[low-resolution\]/, 'a 200 px source is flagged');
    const master = masterPng(out, 'ring');
    assert.deepEqual(analyzeRgba(master.width, master.height, master.rgba).cornerAlphas, [0, 0, 0, 0]);
  });
});

test('import --background keep leaves an opaque background and says export will refuse', () => {
  withTemp((dir) => {
    const src = writePng(path.join(dir, 'a.png'), 128, 128, ringOnBackground(128, [255, 255, 255, 255]));
    const out = path.join(dir, 'w');
    const { code, stdout } = runCli(['import', src, '--out', out, '--name', 'a', '--background', 'keep']);
    assert.equal(code, 0);
    assert.match(stdout, /Background: mode keep -> keep/);
    assert.match(stdout, /\[opaque-corners\].*every export target will refuse/);
    assert.deepEqual(analyzeRgba(128, 128, masterPng(out, 'a').rgba).cornerAlphas, [255, 255, 255, 255]);
  });
});

test('import reports usage errors with exit code 2 and writes nothing', () => {
  withTemp((dir) => {
    const src = writePng(path.join(dir, 'a.png'), 64, 64, glyphIcon(64));
    const out = path.join(dir, 'o');
    for (const args of [
      ['import', src, '--out', out],
      ['import', '--out', out, '--name', 'a'],
      ['import', src, src, '--out', out, '--name', 'a'],
      ['import', src, '--out', out, '--name', 'a', '--background', 'purple'],
      ['import', src, '--out', out, '--name', 'a', '--tolerance', '500'],
      ['import', src, '--out', out, '--name', 'a', '--tolerance', 'lots'],
    ]) {
      const { code, stderr } = runCli(args);
      assert.equal(code, 2, `${args.slice(1).join(' ')} -> ${stderr}`);
    }
    assert.equal(fs.existsSync(out), false);
  });
});

test('import refuses a file that is not an image, a directory and an existing result', () => {
  withTemp((dir) => {
    const out = path.join(dir, 'o');
    const text = path.join(dir, 'picture.png');
    fs.writeFileSync(text, 'this is text, not a PNG');
    let result = runCli(['import', text, '--out', out, '--name', 'a']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a supported image/);
    result = runCli(['import', dir, '--out', out, '--name', 'a']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a regular file/);
    const src = writePng(path.join(dir, 'a.png'), 64, 64, glyphIcon(64));
    assert.equal(runCli(['import', src, '--out', out, '--name', 'a']).code, 0);
    result = runCli(['import', src, '--out', out, '--name', 'a']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pass --force to overwrite/);
    assert.equal(runCli(['import', src, '--out', out, '--name', 'a', '--force']).code, 0);
  });
});

test('import decodes the first frame of a GIF without a browser and says it was animated', () => {
  withTemp((dir) => {
    const out = path.join(dir, 'o');
    const { code, stdout } = runCli(['import', path.join(FIXTURES, 'import-anim.gif'), '--out', out, '--name', 'anim']);
    assert.equal(code, 0);
    assert.match(stdout, /decoded by built-in GIF decoder/);
    assert.match(stdout, /Animated GIF: only the first frame is used/);
    assert.deepEqual(getPixel(masterPng(out, 'anim').rgba, 32, 16, 16), [220, 30, 30, 255]);
  });
});

test('import decodes a JPEG through the browser and removes its white background', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const out = path.join(dir, 'o');
    const { code, stdout, stderr } = runCli(['import', path.join(FIXTURES, 'import-white.jpg'), '--out', out, '--name', 'photo']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /JPEG, 96x96 px.*fully opaque; decoded by browser/);
    assert.match(stdout, /Background: mode auto -> remove/);
    const master = masterPng(out, 'photo');
    assert.deepEqual(analyzeRgba(master.width, master.height, master.rgba).cornerAlphas, [0, 0, 0, 0]);
    const [r, g, b, a] = getPixel(master.rgba, 96, 20, 48); // inside the blue rounded square, left of the disc
    assert.ok(a === 255 && b > 180 && r < 90, `blue body survives JPEG decoding (${r},${g},${b},${a})`);
    assert.deepEqual(getPixel(master.rgba, 96, 48, 48).slice(0, 3).map((v) => v > 230), [true, true, true], 'the enclosed white disc is kept');
  });
});

test('import decodes a WebP with alpha through the browser and keeps its transparent corners', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const out = path.join(dir, 'o');
    const { code, stdout, stderr } = runCli(['import', path.join(FIXTURES, 'import-alpha.webp'), '--out', out, '--name', 'web']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /WEBP, 96x96 px.*has transparency; decoded by browser/);
    assert.match(stdout, /Background: mode auto -> keep; auto: the corners are already transparent/);
    const master = masterPng(out, 'web');
    assert.deepEqual(analyzeRgba(master.width, master.height, master.rgba).cornerAlphas, [0, 0, 0, 0]);
    const [r, g, b, a] = getPixel(master.rgba, 96, 20, 48);
    assert.ok(a === 255 && r > 180 && b < 90, `red body is intact (${r},${g},${b},${a})`);
  });
});

test('import decodes a BMP through the browser with the right orientation', { skip: browserSkip }, () => {
  withTemp((dir) => {
    // 40x20: the TOP half is red, the BOTTOM half blue; a bottom-up BMP decoded wrongly would swap them.
    const bmp = path.join(dir, 'strip.bmp');
    fs.writeFileSync(bmp, makeBmp(40, 20, (x, y) => (y < 10 ? [200, 20, 20] : [20, 20, 200])));
    const out = path.join(dir, 'o');
    const { code, stdout, stderr } = runCli(['import', bmp, '--out', out, '--name', 'strip', '--background', 'keep']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /BMP, 40x20 px/);
    assert.match(stdout, /padded to a 40x40 square \(picture 40x20, centred\)/);
    const master = masterPng(out, 'strip');
    assert.deepEqual([master.width, master.height], [40, 40]);
    assert.deepEqual(getPixel(master.rgba, 40, 20, 12), [200, 20, 20, 255], 'upper picture half is red (picture spans rows 10-29)');
    assert.deepEqual(getPixel(master.rgba, 40, 20, 27), [20, 20, 200, 255], 'lower picture half is blue');
    assert.equal(getPixel(master.rgba, 40, 20, 5)[3], 0, 'padding above the picture is transparent');
  });
});

test('imported masters flow through check and export; the export skips the vector files', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const src = writePng(path.join(dir, 'brand.png'), 300, 300, glyphIcon(300));
    const work = path.join(dir, 'icon-work');
    assert.equal(runCli(['import', src, '--out', work, '--name', 'brand']).code, 0);
    const master = path.join(work, 'brand-master.svg');

    const check = runCli(['check', master, '--out', path.join(work, 'check-1.png')]);
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /16 px transparent render: corners alpha \[0 0 0 0\]/);
    assert.ok(fs.existsSync(path.join(work, 'check-1.png')));

    // Only the targets this test is about (the master and the Windows icon): every
    // render launches a browser, and the full set is covered by the export tests.
    const set = path.join(dir, 'brand-set');
    const exported = runCli(['export', master, '--out', set, '--name', 'brand', '--title', 'Brand', '--only', 'master,windows']);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Not written, because the master is a raster image and no honest vector file exists: icon\.svg\./);
    const listing = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else listing.push(path.relative(set, full).split(path.sep).join('/'));
      }
    };
    walk(set);
    assert.ok(!listing.some((rel) => rel.endsWith('.svg')), `no SVG in the set: ${listing.filter((rel) => rel.endsWith('.svg'))}`);
    assert.deepEqual(listing.sort(), ['icon-1024.png', 'windows/brand.ico']);
    assert.deepEqual(
      parseIco(fs.readFileSync(path.join(set, 'windows', 'brand.ico'))).entries.map((entry) => entry.declaredWidth),
      [16, 24, 32, 48, 64, 128, 256],
    );
  });
});

test('the same pipeline refuses a master whose corners stayed opaque, with the export message', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const src = writePng(path.join(dir, 'opaque.png'), 128, 128, canvas(128, 128, [30, 41, 120, 255]));
    const work = path.join(dir, 'icon-work');
    assert.equal(runCli(['import', src, '--out', work, '--name', 'opaque', '--background', 'keep']).code, 0);
    const exported = runCli(['export', path.join(work, 'opaque-master.svg'), '--out', path.join(dir, 'set'), '--name', 'opaque']);
    assert.equal(exported.code, 1);
    assert.match(exported.stderr, /opaque background/);
    assert.equal(fs.existsSync(path.join(dir, 'set', 'windows')), false, 'nothing is published');
  });
});

test('import decodes a 16-bit PNG through the browser', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const src = path.join(dir, 'deep.png');
    fs.writeFileSync(src, makePng16(64, 64, [200, 30, 30, 255]));
    const out = path.join(dir, 'o');
    const { code, stdout, stderr } = runCli(['import', src, '--out', out, '--name', 'deep', '--background', 'keep']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /PNG, 64x64 px.*decoded by browser/);
    const [r, g, b, a] = getPixel(masterPng(out, 'deep').rgba, 64, 32, 32);
    assert.ok(a === 255 && r > 190 && g < 45 && b < 45, `colour survives the 16-bit decode (${r},${g},${b},${a})`);
  });
});

test('an imported SVG is a real vector master: one file, and the export keeps every vector file', { skip: browserSkip }, () => {
  withTemp((dir) => {
    const work = path.join(dir, 'icon-work');
    const imported = runCli(['import', path.join(FIXTURES, 'terminal.svg'), '--out', work, '--name', 'term']);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /\(SVG, \d+ bytes\) - validated, copied unchanged/);
    assert.deepEqual(fs.readdirSync(work), ['term-master.svg'], 'no PNG master for an SVG source');
    assert.doesNotMatch(imported.stdout, /Background:|Corner alpha|\[[a-z0-9-]+\]/, 'no raster facts or warning codes');

    // master + web is enough to see the vector files (the scalable Linux icon is
    // pinned by the export unit test); fewer targets mean fewer browser launches.
    const set = path.join(dir, 'set');
    const exported = runCli(['export', path.join(work, 'term-master.svg'), '--out', set, '--name', 'term', '--only', 'master,web']);
    assert.equal(exported.code, 0, exported.stderr);
    assert.doesNotMatch(exported.stdout, /Not written/);
    for (const rel of ['icon.svg', 'web/favicon.svg']) {
      assert.ok(fs.existsSync(path.join(set, rel)), `${rel} is written for an SVG source`);
    }
    assert.match(fs.readFileSync(path.join(set, 'web', 'head.html'), 'utf8'), /favicon\.svg/);
  });
});
