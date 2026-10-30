// The estimate of how well a picture redraws as an SVG (svgFit), and the small badge it puts on the contact sheet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { svgFit, measureForSvg, LEVELS } from '../scripts/lib/svgfit.mjs';
import { composeSheet, drawSvgBadge } from '../scripts/lib/contactsheet.mjs';
import { prepareCandidate } from '../scripts/lib/packbuild.mjs';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';

const SIZE = 256;

/** A transparent square with `paint(distance, x, y)` giving the colour of each pixel inside a disc of radius 110 (null = leave it clear). */
function picture(paint, radius = 110) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
      if (distance > radius) continue;
      const colour = paint(distance, x, y);
      if (colour !== null) rgba.set([...colour, 255], (y * SIZE + x) * 4);
    }
  }
  return rgba;
}

const BLACK = [18, 18, 18];
const YELLOW = [251, 204, 13];
const WHITE = [255, 255, 255];

/** What a flat vector icon looks like: a black ring, a yellow body, a white eye. */
const flat = () => picture((distance) => (distance > 98 ? BLACK : distance < 30 ? WHITE : YELLOW));
/** A soft 3D ball: the colour changes smoothly everywhere. */
const ball = () => picture((distance, x, y) => {
  const light = Math.max(0, 1 - Math.hypot(x - 90, y - 85) / 220);
  return [Math.round(40 + 200 * light), Math.round(30 + 170 * light * light), Math.round(20 + 60 * light)];
});
/** Flat colours, but a third of the picture is a smooth ramp between two of them (a gradient fill). */
const rampy = () => picture((distance, x) => (distance > 98 ? BLACK : x < 100 ? YELLOW.map((v, i) => Math.round(v + ((WHITE[i] - v) * (100 - x)) / 100)) : x < 150 ? [120 + x - 100, 90 + (x - 100) * 2, 40] : YELLOW));

test('a flat picture with a dark outline is "high", a soft 3D ball is "low"', () => {
  const flatFit = svgFit({ rgba: flat(), size: SIZE });
  const ballFit = svgFit({ rgba: ball(), size: SIZE });
  assert.equal(flatFit.level, 'high', `flat: ${flatFit.score} ${flatFit.reasons.join('; ')}`);
  assert.equal(ballFit.level, 'low', `ball: ${ballFit.score} ${ballFit.reasons.join('; ')}`);
  assert.ok(flatFit.score >= LEVELS.high && ballFit.score < LEVELS.medium);
  assert.ok(flatFit.reasons.some((reason) => /flat colours/.test(reason)));
  assert.ok(flatFit.reasons.some((reason) => /dark outline/.test(reason)));
  assert.ok(ballFit.reasons.some((reason) => /many blended colours|shading/.test(reason)));
});

test('smooth gradients pull a few-colour picture down even though its colour count looks flat', () => {
  const plain = svgFit({ rgba: flat(), size: SIZE });
  const ramp = svgFit({ rgba: rampy(), size: SIZE });
  assert.ok(ramp.measured.shaded > 0.1, `the ramp is measured as shading (${ramp.measured.shaded.toFixed(3)})`);
  assert.ok(ramp.score < plain.score - 10, `${ramp.score} against ${plain.score}`);
  assert.ok(ramp.reasons.some((reason) => /shading or gradients/.test(reason)));
});

test('the estimate is measured from the picture alone', () => {
  const result = svgFit({ rgba: flat(), size: SIZE });
  assert.deepEqual(Object.keys(result).sort(), ['level', 'measured', 'reasons', 'score']);
  assert.ok(!result.reasons.some((reason) => /style/.test(reason)));
});

test('an empty picture is "low" and says why; a big master is measured at a fixed working size', () => {
  const empty = svgFit({ rgba: Buffer.alloc(SIZE * SIZE * 4), size: SIZE });
  assert.equal(empty.level, 'low');
  assert.deepEqual(empty.reasons, ['nothing visible to redraw']);
  assert.equal(measureForSvg(Buffer.alloc(SIZE * SIZE * 4), SIZE), null);
  // the same picture drawn at 512 px measures about the same as at 256
  const big = Buffer.alloc(512 * 512 * 4);
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) {
      const distance = Math.hypot(x + 0.5 - 256, y + 0.5 - 256);
      if (distance <= 220) big.set([...(distance > 196 ? BLACK : distance < 60 ? WHITE : YELLOW), 255], (y * 512 + x) * 4);
    }
  }
  const small = svgFit({ rgba: flat(), size: SIZE });
  const large = svgFit({ rgba: big, size: 512 });
  assert.equal(large.level, small.level);
  assert.ok(Math.abs(large.score - small.score) <= 8, `${large.score} against ${small.score}`);
});

test('the sheet badge: three, two or one filled dot, and nothing for an unknown level', () => {
  const colourOf = (level) => {
    const canvas = Buffer.alloc(200 * 40 * 4);
    const used = drawSvgBadge(canvas, 200, 10, 10, level);
    const filled = new Set();
    for (let x = 0; x < 200; x += 1) {
      const o = (14 * 200 + x) * 4; // the row through the middle of the dots (they are drawn from y 11 to 18)
      if (canvas[o + 3] === 255) filled.add(`${canvas[o]},${canvas[o + 1]},${canvas[o + 2]}`);
    }
    return { used, colours: [...filled] };
  };
  assert.ok(colourOf('high').colours.includes('38,148,78'));
  assert.ok(colourOf('medium').colours.includes('196,132,20'));
  assert.ok(colourOf('low').colours.includes('120,126,136'));
  assert.equal(colourOf('nope').used, 0);
  assert.equal(colourOf(undefined).colours.length, 0);
});

test('the contact sheet carries the badge of each candidate, and prepareCandidate reports the estimate', () => {
  const png = encodePng(SIZE, SIZE, flat());
  const prepared = prepareCandidate(png, { crop: false });
  assert.equal(prepared.facts.svgFit.level, 'high');
  assert.deepEqual(Object.keys(prepared.facts.svgFit).sort(), ['level', 'reasons', 'score']);
  assert.ok(Array.isArray(prepared.facts.svgFit.reasons));
  const sheet = decodePng(composeSheet([{ number: 1, prepared }]));
  let green = 0;
  for (let y = 24; y < 36; y += 1) {
    for (let x = 0; x < sheet.width; x += 1) {
      const o = (y * sheet.width + x) * 4;
      if (sheet.rgba[o] === 38 && sheet.rgba[o + 1] === 148 && sheet.rgba[o + 2] === 78) green += 1;
    }
  }
  assert.equal(green, 3 * 8 * 8, 'three green dots in the header');
});
