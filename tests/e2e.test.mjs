// End-to-end tests that use a real renderer. They run whenever a browser or
// CLI renderer is discoverable and skip (with a clear message) otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRenderers, renderSvgPng } from '../scripts/lib/renderers.mjs';
import { renderSheet } from '../scripts/lib/sheet.mjs';
import { runExport } from '../scripts/lib/export.mjs';
import { parseIco } from '../scripts/lib/ico.mjs';
import { parseIcns } from '../scripts/lib/icns.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { removeTree } from './helpers.mjs';

const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const hasRenderer = discovery.chosen !== null;
const skipReason = hasRenderer
  ? undefined
  : `no renderer on this machine (looked for Chrome/Chromium/Edge, resvg, rsvg-convert, inkscape, magick)`;

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-e2e-'));
}

test('render produces exact transparent PNGs at small and large sizes', { skip: skipReason }, async () => {
  const base = tempBase();
  try {
    for (const size of [16, 32, 256]) {
      const out = path.join(base, `clock-${size}.png`);
      const result = await renderSvgPng({
        svgPath: path.resolve('tests/fixtures/clock.svg'),
        size,
        outPath: out,
        renderer: discovery.chosen,
        tempDir: base,
      });
      assert.equal(result.width, size);
      assert.equal(result.height, size);
      assert.deepEqual(result.analysis.cornerAlphas, [0, 0, 0, 0], 'corners must be transparent');
      assert.ok(result.analysis.visibleRatio > 0.3, 'the icon should have plenty of ink');
      // the fixture's container is a rounded rect with ~3% padding per side
      assert.ok(result.analysis.bbox.width >= size * 0.9, 'the container should fill the canvas');
    }
  } finally {
    removeTree(base);
  }
});

test('a full export through the real renderer round-trips in both containers', { skip: skipReason }, async () => {
  const base = tempBase();
  try {
    const outDir = path.join(base, 'out');
    const result = await runExport({
      svgPath: path.resolve('tests/fixtures/webhook.svg'),
      outDir,
      name: 'e2e-app',
      title: 'E2E App',
      render: (svg, size, outPath) =>
        renderSvgPng({ svgPath: svg, size, outPath, renderer: discovery.chosen, tempDir: base }),
      workDir: path.join(base, 'work'),
    });
    assert.ok(result.files.length >= 20);
    const ico = parseIco(fs.readFileSync(path.join(outDir, 'windows/e2e-app.ico')));
    assert.deepEqual(ico.entries.map((entry) => entry.declaredWidth), [16, 24, 32, 48, 64, 128, 256]);
    const icns = parseIcns(fs.readFileSync(path.join(outDir, 'macos/e2e-app.icns')));
    assert.equal(icns.chunks.length, 11);
    // decode one real payload end to end: (30,30) sits on the gradient
    // container (orange-red, opaque); the corners are transparent.
    const apple = decodePng(fs.readFileSync(path.join(outDir, 'web/apple-touch-icon.png')));
    assert.equal(apple.width, 180);
    const probe = (30 * 180 + 30) * 4;
    assert.equal(apple.rgba[probe + 3], 255, 'probe point on the container must be opaque');
    assert.ok(apple.rgba[probe] > 150, `red channel should dominate: ${apple.rgba[probe]}`);
    assert.equal(apple.rgba[3], 0, 'top-left corner transparent');
  } finally {
    removeTree(base);
  }
});

test('a contact sheet renders with the exact computed viewport', { skip: skipReason }, async () => {
  const base = tempBase();
  try {
    const out = path.join(base, 'sheet.png');
    await renderSheet({
      svgPaths: [path.resolve('tests/fixtures/terminal.svg'), path.resolve('tests/fixtures/clock.svg')],
      outPath: out,
      renderer: discovery.chosen,
      tempDir: base,
      sizes: [64, 16],
    });
    const decoded = decodePng(fs.readFileSync(out));
    assert.equal(decoded.width, 2 * 288);
    assert.equal(decoded.height, 2 * 2 * 288 + 8);
  } finally {
    removeTree(base);
  }
});
