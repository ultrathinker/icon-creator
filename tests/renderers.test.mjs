import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRenderers, noRendererMessage, renderPageHtml, verifyRenderedPng, renderSvgPng } from '../scripts/lib/renderers.mjs';
import { renderSheet } from '../scripts/lib/sheet.mjs';
import { encodePng } from '../scripts/lib/png.mjs';

function discoveryWith({ platform = 'win32', pathValue = '', files = [] }) {
  // `files` holds original-case paths; existence is matched case-insensitively.
  const known = new Set(files.map((file) => file.toLowerCase()));
  const exists = (candidate) => known.has(candidate.toLowerCase());
  return discoverRenderers({ platform, pathValue, exists });
}

test('finds Chrome in its well-known Windows install location', () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const result = discoveryWith({ files: [chrome] });
  assert.equal(result.chosen.name, 'chrome');
  assert.equal(result.chosen.kind, 'browser');
  assert.equal(result.chosen.path, chrome);
});

test('falls back to Edge when Chrome and Chromium are absent', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const result = discoveryWith({ files: [edge] });
  assert.equal(result.chosen.name, 'edge');
});

test('a browser always beats a command-line tool', () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const resvg = 'C:\\tools\\resvg.exe';
  const result = discoveryWith({ pathValue: 'C:\\tools;', files: [chrome, resvg] });
  assert.equal(result.chosen.kind, 'browser');
  assert.ok(result.candidates.find((c) => c.name === 'resvg').found);
});

test('nothing exists means no renderer, with a helpful null', () => {
  const result = discoveryWith({ pathValue: '/usr/bin:/usr/local/bin', platform: 'linux' });
  assert.equal(result.chosen, null);
  assert.ok(result.candidates.every((candidate) => candidate.found === null));
});

test('a CLI tool is chosen only when no browser exists', () => {
  const withRsvg = discoveryWith({
    platform: 'linux',
    pathValue: '/usr/bin:/usr/local/bin',
    files: ['/usr/bin/rsvg-convert'],
  });
  assert.equal(withRsvg.chosen.name, 'rsvg-convert');
  assert.equal(withRsvg.chosen.kind, 'cli');
  assert.match(withRsvg.chosen.origin, /PATH/);
});

test('PATH entries are split per platform and .exe is appended on Windows', () => {
  const result = discoveryWith({
    pathValue: 'C:\\a;C:\\b',
    files: ['C:\\b\\inkscape.exe'],
  });
  const inkscape = result.candidates.find((c) => c.name === 'inkscape');
  assert.equal(inkscape.found.path, 'C:\\b\\inkscape.exe');
});

test('macOS looks in /Applications bundles', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const result = discoveryWith({ platform: 'darwin', files: [chrome] });
  assert.equal(result.chosen.name, 'chrome');
  assert.equal(result.chosen.path, chrome);
});

test('unknown platforms fall back to the Linux candidate list', () => {
  const result = discoveryWith({ platform: 'freebsd', files: ['/usr/bin/chromium'] });
  assert.equal(result.chosen.name, 'chromium');
});

test('candidates carry the locations that were checked', () => {
  const result = discoveryWith({});
  const chrome = result.candidates.find((c) => c.name === 'chrome');
  assert.ok(chrome.checked.some((entry) => entry.includes('Chrome')));
  assert.ok(chrome.checked.some((entry) => entry.startsWith('PATH:')));
  assert.equal(chrome.found, null);
});

test('noRendererMessage tells the user what to install', () => {
  const message = noRendererMessage();
  assert.match(message, /Chrome/);
  assert.match(message, /resvg/);
  assert.match(message, /doctor/);
});

test('renderPageHtml embeds the SVG as an img with exact pixel size', () => {
  const html = renderPageHtml('file:///C:/icons/a.svg', 24);
  assert.match(html, /<img src="file:\/\/\/C:\/icons\/a\.svg"/);
  assert.match(html, /width:24px/);
  assert.match(html, /height:24px/);
  assert.doesNotMatch(html, /<svg/);
});

function transparentSquarePng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 2; y < size - 2; y += 1) {
    for (let x = 2; x < size - 2; x += 1) {
      rgba[(y * size + x) * 4] = 120;
      rgba[(y * size + x) * 4 + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function opaqueSquarePng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 120;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(size, size, rgba);
}

test('verifyRenderedPng accepts a transparent render of the exact size', () => {
  const verified = verifyRenderedPng(transparentSquarePng(16), 16);
  assert.equal(verified.width, 16);
  assert.deepEqual(verified.analysis.cornerAlphas, [0, 0, 0, 0]);
});

test('verifyRenderedPng rejects wrong dimensions', () => {
  assert.throws(() => verifyRenderedPng(transparentSquarePng(32), 16), /produced 32x32, wanted 16x16/);
});

test('verifyRenderedPng rejects an opaque background', () => {
  assert.throws(() => verifyRenderedPng(opaqueSquarePng(16), 16), /opaque background.*transparent corners/s);
});

test('verifyRenderedPng rejects a completely blank render', () => {
  const blank = encodePng(16, 16, Buffer.alloc(16 * 16 * 4));
  assert.throws(() => verifyRenderedPng(blank, 16), /completely blank/);
});

const stubRenderer = { kind: 'browser', label: 'stub', path: 'nowhere' };

test('renderSvgPng refuses to replace an existing output file', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const out = path.join(base, 'existing.png');
    fs.writeFileSync(out, 'precious');
    await assert.rejects(
      renderSvgPng({ svgPath: 'whatever.svg', size: 16, outPath: out, renderer: stubRenderer, tempDir: base }),
      /already exists; pass --force/,
    );
    assert.equal(fs.readFileSync(out, 'utf8'), 'precious');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSheet refuses to replace an existing sheet file', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const out = path.join(base, 'sheet.png');
    fs.writeFileSync(out, 'precious');
    await assert.rejects(
      renderSheet({ svgPaths: ['a.svg'], outPath: out, renderer: stubRenderer, tempDir: base, sizes: [16] }),
      /already exists; pass --force/,
    );
    assert.equal(fs.readFileSync(out, 'utf8'), 'precious');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const fileLinkSkipReason = (() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-flink-'));
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    fs.rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch {
    return 'this user cannot create file symlinks here';
  }
})();

test('renderSvgPng refuses a symbolic link at the output path', { skip: fileLinkSkipReason }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'precious');
    const out = path.join(base, 'aliased.png');
    fs.symlinkSync(outside, out);
    await assert.rejects(
      renderSvgPng({ svgPath: 'x.svg', size: 16, outPath: out, renderer: stubRenderer, tempDir: base, force: true }),
      /symbolic link: refusing to write through it/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSheet refuses a symbolic link at the output path', { skip: fileLinkSkipReason }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'precious');
    const out = path.join(base, 'aliased.png');
    fs.symlinkSync(outside, out);
    await assert.rejects(
      renderSheet({ svgPaths: ['a.svg'], outPath: out, renderer: stubRenderer, tempDir: base, sizes: [16], force: true }),
      /symbolic link: refusing to write through it/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSvgPng refuses a symbolic link in the parent directory of the output', { skip: fileLinkSkipReason }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const outsideDir = path.join(base, 'outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(base, 'redirect'));
    await assert.rejects(
      renderSvgPng({
        svgPath: 'x.svg',
        size: 16,
        outPath: path.join(base, 'redirect', 'rendered.png'),
        renderer: stubRenderer,
        tempDir: base,
      }),
      /symbolic link or junction: refusing to write through it - pass the real path instead/,
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSheet refuses a symbolic link in the parent directory of the output', { skip: fileLinkSkipReason }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    const outsideDir = path.join(base, 'outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(base, 'redirect'));
    await assert.rejects(
      renderSheet({
        svgPaths: ['a.svg'],
        outPath: path.join(base, 'redirect', 'sheet.png'),
        renderer: stubRenderer,
        tempDir: base,
        sizes: [16],
      }),
      /symbolic link or junction: refusing to write through it - pass the real path instead/,
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSvgPng refuses an output whose parent directory does not exist', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-guard-'));
  try {
    await assert.rejects(
      renderSvgPng({
        svgPath: 'x.svg',
        size: 16,
        outPath: path.join(base, 'no-such-dir', 'out.png'),
        renderer: stubRenderer,
        tempDir: base,
      }),
      /does not exist; create it first/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
