// Contact-sheet composition: layout, colors and renderer independence.
// These tests inject a fake per-cell render, so they run without any
// renderer installed and prove the composition itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSheet } from '../scripts/lib/sheet.mjs';
import { encodePng, decodePng } from '../scripts/lib/png.mjs';
import { removeTree } from './helpers.mjs';

const MASTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<rect x="8" y="8" width="240" height="240" rx="56" fill="#123456"/></svg>';

function solidIconPng(size, red) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = Math.max(1, Math.round(size / 16));
  for (let y = inset; y < size - inset; y += 1) {
    for (let x = inset; x < size - inset; x += 1) {
      rgba[(y * size + x) * 4] = red;
      rgba[(y * size + x) * 4 + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function makeFakeRender() {
  const calls = [];
  const render = async (svgPath, size, outPath) => {
    calls.push({ svg: path.basename(svgPath), size });
    fs.writeFileSync(outPath, solidIconPng(size, path.basename(svgPath) === 'concept-b.svg' ? 200 : 40));
  };
  return { render, calls };
}

function pixel(decoded, x, y) {
  const offset = (y * decoded.width + x) * 4;
  return [decoded.rgba[offset], decoded.rgba[offset + 1], decoded.rgba[offset + 2], decoded.rgba[offset + 3]];
}

const CLI_RENDERER = { name: 'resvg', label: 'resvg', kind: 'cli', path: 'C:\\nowhere\\resvg.exe' };

test('sheets compose with exact layout, backgrounds and centered icons for any renderer kind', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-sheet-'));
  try {
    const a = path.join(base, 'concept-a.svg');
    const b = path.join(base, 'concept-b.svg');
    fs.writeFileSync(a, MASTER_SVG);
    fs.writeFileSync(b, MASTER_SVG);
    const fake = makeFakeRender();
    const out = path.join(base, 'sheet.png');
    const result = await renderSheet({
      svgPaths: [a, b],
      outPath: out,
      renderer: CLI_RENDERER, // the finding: sheets must not need a browser
      tempDir: base,
      sizes: [64, 16],
      render: fake.render,
    });
    assert.equal(result.width, 2 * 288);
    assert.equal(result.height, 2 * 2 * 288 + 8);
    const decoded = decodePng(fs.readFileSync(out));
    assert.deepEqual(decoded.width, result.width);
    // light block corner is white, dark block corner is near-black
    assert.deepEqual(pixel(decoded, 0, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixel(decoded, result.width - 1, result.height - 1), [16, 18, 22, 255]);
    // the divider strip between the blocks is the neutral grey seam
    assert.deepEqual(pixel(decoded, 0, 2 * 288 - 1), [255, 255, 255, 255]);
    assert.deepEqual(pixel(decoded, 0, 2 * 288), [154, 160, 166, 255]);
    assert.deepEqual(pixel(decoded, 0, 2 * 288 + 8 - 1), [154, 160, 166, 255]);
    // icon ink sits at the center of the first cell (concept a -> red 40)
    const center = pixel(decoded, 144, 144);
    assert.equal(center[0], 40);
    assert.equal(center[3], 255);
    // each (svg, size) pair is rendered exactly once, reusing across blocks
    const keys = fake.calls.map((call) => `${call.svg}:${call.size}`);
    assert.equal(keys.length, new Set(keys).size);
    assert.equal(fake.calls.length, 2 * 2);
  } finally {
    removeTree(base);
  }
});

test('a sheet refuses an output that already exists, even for CLI renderers', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-sheet-'));
  try {
    const a = path.join(base, 'a.svg');
    fs.writeFileSync(a, MASTER_SVG);
    const out = path.join(base, 'sheet.png');
    fs.writeFileSync(out, 'precious');
    await assert.rejects(
      renderSheet({ svgPaths: [a], outPath: out, renderer: CLI_RENDERER, tempDir: base, sizes: [16], render: makeFakeRender().render }),
      /already exists; pass --force/,
    );
    assert.equal(fs.readFileSync(out, 'utf8'), 'precious');
  } finally {
    removeTree(base);
  }
});

test('an oversized size grows its cell instead of cropping the icon', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-sheet-'));
  try {
    const a = path.join(base, 'a.svg');
    fs.writeFileSync(a, MASTER_SVG);
    // fully-filled 512 px icons: any clipping would eat opaque pixels
    const fake = {
      render: async (svgPath, size, outPath) => {
        const rgba = Buffer.alloc(size * size * 4);
        for (let i = 0; i < size * size; i += 1) {
          rgba[i * 4] = 90;
          rgba[i * 4 + 1] = 90;
          rgba[i * 4 + 2] = 160;
          rgba[i * 4 + 3] = 255;
        }
        fs.writeFileSync(outPath, encodePng(size, size, rgba));
      },
    };
    const out = path.join(base, 'sheet.png');
    const result = await renderSheet({
      svgPaths: [a],
      outPath: out,
      renderer: CLI_RENDERER,
      tempDir: base,
      sizes: [512],
      render: fake.render,
    });
    assert.equal(result.width, 512 + 2 * 16); // cell = size + padding on each side
    assert.equal(result.height, 2 * result.width + 8);
    const decoded = decodePng(fs.readFileSync(out));
    // background at the cell corner, icon ink immediately inside the pad
    assert.deepEqual(pixel(decoded, 0, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixel(decoded, 16, 16), [90, 90, 160, 255]);
    assert.deepEqual(pixel(decoded, result.width - 1 - 16, result.width - 1 - 16), [90, 90, 160, 255]);
  } finally {
    removeTree(base);
  }
});

test('a sheet with a single concept and single size still lays out correctly', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-sheet-'));
  try {
    const a = path.join(base, 'a.svg');
    fs.writeFileSync(a, MASTER_SVG);
    const out = path.join(base, 'sheet.png');
    const result = await renderSheet({
      svgPaths: [a],
      outPath: out,
      renderer: CLI_RENDERER,
      tempDir: base,
      sizes: [48],
      render: makeFakeRender().render,
    });
    const decoded = decodePng(fs.readFileSync(out));
    assert.equal(decoded.width, 288);
    assert.equal(decoded.height, 2 * 288 + 8);
    // icon ink at the single cell's center, both blocks
    assert.equal(pixel(decoded, 144, 144)[3], 255);
    assert.equal(pixel(decoded, 144, 288 + 8 + 144)[3], 255);
  } finally {
    removeTree(base);
  }
});
