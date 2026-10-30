// The pale rim a cut-out leaves outside a dark outline, and how it is taken off (cleanDarkEdge, wired into prepareCandidate).
// The pictures are drawn here, pixel by pixel: a dark disc whose edge is blurred into a white background (what a soft
// drawing or JPEG does), with other things next to it that must NOT change.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';
import { removeBackground, cleanDarkEdge, edgeBand, borderReference } from '../scripts/lib/pixels.mjs';
import { prepareCandidate } from '../scripts/lib/packbuild.mjs';

const SIZE = 512;
const CENTRE = SIZE / 2;
const WHITE = [255, 255, 255];
const INK = [12, 12, 12];

const mix = (from, to, t) => from.map((value, i) => Math.round(value * (1 - t) + to[i] * t));

/**
 * One picture: `paint(distance, x, y)` gives the colour of a pixel from its distance to the centre (null = background).
 * A dark disc of radius `radius` is blurred into the background over `halo` pixels.
 */
function scene({ radius = 150, halo = 6, background = WHITE, inner = () => null, outer = () => null } = {}) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - CENTRE, y + 0.5 - CENTRE);
      let colour = outer(distance, x, y) ?? background;
      if (distance <= radius) colour = INK;
      else if (distance <= radius + halo && outer(distance, x, y) === null) colour = mix(INK, background, (distance - radius) / halo);
      colour = inner(distance, x, y) ?? colour;
      const o = (y * SIZE + x) * 4;
      rgba[o] = colour[0];
      rgba[o + 1] = colour[1];
      rgba[o + 2] = colour[2];
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

const cutOut = (rgba, background = WHITE) => removeBackground(rgba, SIZE, SIZE, { r: background[0], g: background[1], b: background[2] }, 32).rgba;
const cleaned = (rgba, background = WHITE) => cleanDarkEdge(rgba, SIZE, SIZE, { r: background[0], g: background[1], b: background[2] });

/** Visible pixels outside `radius` that look pale: the rim. */
function paleOutside(rgba, radius) {
  let count = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (Math.hypot(x + 0.5 - CENTRE, y + 0.5 - CENTRE) <= radius + 0.5) continue;
      const o = (y * SIZE + x) * 4;
      if (rgba[o + 3] >= 40 && Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) > 100) count += 1;
    }
  }
  return count;
}

const pixel = (rgba, x, y) => [...rgba.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4)];

test('the band is 0.4 % of the image, between 3 and 10 pixels', () => {
  assert.equal(edgeBand(64, 64), 3);
  assert.equal(edgeBand(1024, 1024), 4);
  assert.equal(edgeBand(2048, 2048), 8);
  assert.equal(edgeBand(8192, 8192), 10);
  assert.equal(edgeBand(2048, 512), 3, 'the shorter side decides');
});

test('a pale rim outside a dark outline is taken off', () => {
  const cut = cutOut(scene({ halo: 6 }));
  assert.ok(paleOutside(cut, 150) > 100, 'the cut-out alone leaves a pale rim, so the test means something');
  const result = cleaned(cut);
  assert.ok(result.cleaned > 100, 'pixels were cleaned');
  assert.equal(paleOutside(result.rgba, 150), 0, 'no pale pixel is left outside the outline');
  assert.deepEqual(pixel(result.rgba, CENTRE, CENTRE).slice(0, 3), INK, 'the outline itself is untouched');
  assert.equal(pixel(result.rgba, 2, 2)[3], 0, 'the background stays transparent');
});

test('the cleaned edge is the outline colour with a soft alpha, not a hard cut', () => {
  const result = cleaned(cutOut(scene({ halo: 6 })));
  const alphas = new Set();
  for (let x = CENTRE + 148; x <= CENTRE + 160; x += 1) {
    const [r, g, b, a] = pixel(result.rgba, x, CENTRE);
    if (a > 0) assert.ok(r <= 80 && g <= 80 && b <= 80, `a visible edge pixel is dark (${r},${g},${b},${a})`);
    alphas.add(a);
  }
  assert.ok(alphas.size >= 3, `the alpha ramps down over several pixels (${[...alphas].join(',')})`);
});

test('a light area inside the outline is left alone', () => {
  const eye = (distance) => (distance <= 40 ? WHITE : null);
  const result = cleaned(cutOut(scene({ halo: 6, inner: eye })));
  assert.deepEqual(pixel(result.rgba, CENTRE, CENTRE), [255, 255, 255, 255], 'the white eye is still opaque white');
  assert.deepEqual(pixel(result.rgba, CENTRE + 30, CENTRE), [255, 255, 255, 255]);
});

test('a picture with no dark outline is not touched', () => {
  const red = [200, 40, 40];
  const rgba = scene({ halo: 6, inner: (distance) => (distance <= 150 ? red : null) });
  // a red disc with a red-to-white blur
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - CENTRE, y + 0.5 - CENTRE);
      if (distance > 150 && distance <= 156) {
        const colour = mix(red, WHITE, (distance - 150) / 6);
        rgba.set([...colour, 255], (y * SIZE + x) * 4);
      }
    }
  }
  const cut = cutOut(rgba);
  const result = cleaned(cut);
  assert.equal(result.cleaned, 0);
  assert.ok(result.rgba.equals(cut), 'not one byte changed');
});

test('a coloured border next to the outline is paint, not a halo, and stays', () => {
  const yellow = [251, 204, 13];
  const border = (distance) => (distance > 150 && distance <= 154 ? yellow : null);
  const cut = cutOut(scene({ halo: 0, outer: border }));
  const result = cleaned(cut);
  assert.equal(result.cleaned, 0, 'nothing was taken for a halo');
  assert.ok(result.rgba.equals(cut), 'the yellow ring is exactly as the cut-out left it');
});

test('a pale border wider than three bands is kept whole', () => {
  const blue = [200, 215, 240];
  const width = 24;
  const border = (distance) => (distance > 150 && distance <= 150 + width ? blue : null);
  const cut = cutOut(scene({ halo: 0, outer: border }));
  const result = cleaned(cut);
  assert.ok(result.rgba.equals(cut), 'the sticker-like border is not a rim');
});

test('a pale glow around a dark shape on a dark background is design, not a rim, and stays', () => {
  const black = [0, 0, 0];
  const glow = [200, 200, 200];
  const cut = cutOut(scene({ halo: 0, background: black, outer: (distance) => (distance > 150 && distance <= 154 ? glow : null) }), black);
  const result = cleaned(cut, black);
  assert.equal(result.cleaned, 0);
  assert.ok(result.rgba.equals(cut), 'the glow is exactly as the cut-out left it');
  assert.deepEqual(pixel(result.rgba, CENTRE + 152, CENTRE), [200, 200, 200, 255]);
});

test('a picture that is already transparent has no background colour to judge against, and prepareCandidate skips the step', () => {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (Math.hypot(x + 0.5 - CENTRE, y + 0.5 - CENTRE) <= 150) rgba.set([12, 12, 12, 255], (y * SIZE + x) * 4);
    }
  }
  const prepared = prepareCandidate(encodePng(SIZE, SIZE, rgba));
  assert.equal(prepared.facts.edgeCleanedPercent, 0);
});

test('prepareCandidate cleans the rim by default, reports it, and --no-edge-clean (edgeClean: false) keeps it', () => {
  const png = encodePng(SIZE, SIZE, scene({ halo: 6 }));
  const on = prepareCandidate(png, { crop: false });
  const off = prepareCandidate(png, { crop: false, edgeClean: false });
  assert.ok(on.facts.edgeCleanedPercent > 0);
  assert.equal(off.facts.edgeCleanedPercent, 0);
  const pale = (prepared) => paleOutside(decodePng(prepared.png).rgba, 150);
  assert.equal(pale(on), 0, 'the finished master has no pale rim');
  assert.ok(pale(off) > 100, 'with the step off the rim is still there');
});

test('borderReference still finds the white of this scene', () => {
  assert.deepEqual(borderReference(scene({ halo: 6 }), SIZE, SIZE), { r: 255, g: 255, b: 255 });
});
