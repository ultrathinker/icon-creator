// A stand-in for a command-line SVG renderer such as resvg, used by the tests (never shipped as a tool).
// Arguments: <svg file> <png file> <size>. It writes a valid PNG of that size (transparent corners, opaque middle) and
// records what it was given, from the environment:
//
//   FAKE_TOOL_SEEN   file that receives one JSON line per launch: the path of the SVG it was given and the text found
//                    at that path at that moment
//   FAKE_TOOL_SWAP   with FAKE_TOOL_SEEN: a file that is overwritten with FAKE_TOOL_SWAP_TEXT just before the SVG is
//                    read (somebody replacing the user's SVG after the check)

import fs from 'node:fs';
import { encodePng } from '../../scripts/lib/png.mjs';

const [svgPath, outPath, sizeText] = process.argv.slice(2);
const size = Number(sizeText);

if (process.env.FAKE_TOOL_SWAP) fs.writeFileSync(process.env.FAKE_TOOL_SWAP, process.env.FAKE_TOOL_SWAP_TEXT ?? '');
if (process.env.FAKE_TOOL_SEEN) {
  fs.appendFileSync(process.env.FAKE_TOOL_SEEN, `${JSON.stringify({ svgPath, text: fs.readFileSync(svgPath, 'utf8') })}\n`);
}

const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const inside = x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4;
    if (inside) rgba.set([200, 40, 40, 255], (y * size + x) * 4);
  }
}
fs.writeFileSync(outPath, encodePng(size, size, rgba));
