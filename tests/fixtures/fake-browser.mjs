// A stand-in for headless Chrome, used by the tests (never shipped as a tool).
// It understands the few flags the renderer passes: --screenshot=<file> and
// --window-size=<w>,<h>. Behaviour comes from the environment:
//
//   FAKE_BROWSER_MODE   exit         write a valid PNG and exit (a normal browser)
//                       linger       write a valid PNG, then keep running (the macOS bug)
//                       partial      write half of the PNG, pause, write the rest, exit
//                       silent       write nothing and keep running
//                       silent-once  like silent for the first launch, like linger afterwards
//   FAKE_BROWSER_PIDS   file that receives one line per launch: "<fake pid> <helper pid>"
//   FAKE_BROWSER_SEEN   file that receives one JSON line per launch: the address of the <img> on the page it was given
//                       and the text found at that address at that moment
//   FAKE_BROWSER_SWAP   with FAKE_BROWSER_SEEN: a file that is overwritten with FAKE_BROWSER_SWAP_TEXT just before the
//                       page is read (somebody replacing the user's SVG after the check)
//
// Like Chrome it starts a helper process of its own. A browser that lingers
// leaves the helper running too: ending only the launcher would leak it.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../scripts/lib/png.mjs';

const arg = (prefix) => process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const outPath = arg('--screenshot=');
const [width, height] = (arg('--window-size=') || '16,16').split(',').map(Number);
let mode = process.env.FAKE_BROWSER_MODE || 'exit';
const pidsFile = process.env.FAKE_BROWSER_PIDS;

// On Windows a plain child of a node process dies with it (libuv puts it in the
// parent's job object), which a real browser's helpers do not; detaching makes
// the helper outlive the launcher there, so only a tree kill can end it. On POSIX
// it must stay in the launcher's process group, which is what the tool signals.
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
  stdio: 'ignore',
  windowsHide: true,
  detached: process.platform === 'win32',
});
let firstLaunch = true;
if (pidsFile) {
  firstLaunch = !fs.existsSync(pidsFile) || fs.readFileSync(pidsFile, 'utf8').trim() === '';
  fs.appendFileSync(pidsFile, `${process.pid} ${helper.pid}\n`);
}
if (mode === 'silent-once') mode = firstLaunch ? 'silent' : 'linger';

if (process.env.FAKE_BROWSER_SEEN) {
  const html = fs.readFileSync(fileURLToPath(process.argv[process.argv.length - 1]), 'utf8');
  const src = /<img\b[^>]*?\bsrc="([^"]+)"/.exec(html)?.[1] ?? null;
  if (process.env.FAKE_BROWSER_SWAP) fs.writeFileSync(process.env.FAKE_BROWSER_SWAP, process.env.FAKE_BROWSER_SWAP_TEXT ?? '');
  const text = src === null ? null : fs.readFileSync(fileURLToPath(src), 'utf8');
  fs.appendFileSync(process.env.FAKE_BROWSER_SEEN, `${JSON.stringify({ src, text })}\n`);
}

// Transparent corners, opaque middle: what the renderer's checks expect.
function picture() {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= width / 4 && x < (width * 3) / 4 && y >= height / 4 && y < (height * 3) / 4;
      if (inside) rgba.set([200, 40, 40, 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, rgba);
}

const keepRunning = () => setInterval(() => {}, 1000);

if (mode === 'silent') {
  keepRunning();
} else if (mode === 'partial') {
  const bytes = picture();
  fs.writeFileSync(outPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
  setTimeout(() => {
    fs.writeFileSync(outPath, bytes);
    helper.kill();
    process.exit(0);
  }, 700);
} else {
  fs.writeFileSync(outPath, picture());
  if (mode === 'linger') keepRunning();
  else {
    helper.kill();
    process.exit(0);
  }
}
