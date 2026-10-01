// Renderer discovery and SVG-to-PNG rendering.
//
// Preferred renderer: a headless Chromium-family browser (Chrome, Chromium,
// Edge) — installed on nearly every desktop and the most faithful SVG
// renderer. Fallbacks, in order: resvg, rsvg-convert, inkscape, magick.
// Discovery is a pure function (injectable platform/PATH/existence probe) so
// it can be tested without launching anything; rendering then shells out with
// a hidden window and verifies every output PNG.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateSvg } from './svgcheck.mjs';
import { pngInfo, decodePng, analyzeRgba } from './png.mjs';
import { resolveOutputFile, resolveInputFile, publishExclusive } from './publish.mjs';

/**
 * Verify a rendered PNG before anything else consumes it: exact pixel size
 * and a transparent background (all four corner pixels alpha 0), and not
 * completely blank. Opaque
 * corners mean the renderer painted a background or the icon is full-bleed;
 * both would corrupt every container that expects transparency.
 */
export function verifyRenderedPng(pngBuffer, size, { label = 'the renderer' } = {}) {
  const info = pngInfo(pngBuffer);
  if (info.width !== size || info.height !== size) {
    throw new Error(`${label} produced ${info.width}x${info.height}, wanted ${size}x${size}`);
  }
  const decoded = decodePng(pngBuffer);
  const analysis = analyzeRgba(decoded.width, decoded.height, decoded.rgba);
  if (analysis.cornerAlphas.some((alpha) => alpha !== 0)) {
    throw new Error(
      `${label} produced an opaque background (corner alpha ${analysis.cornerAlphas.join(' ')}): ` +
        'icons must render with transparent corners - use a container with padding or rounded corners',
    );
  }
  if (analysis.visibleRatio === 0) {
    throw new Error(
      `${label} produced a completely blank image: the SVG drew nothing visible ` +
        '(a malformed or unsupported SVG renders as an empty picture)',
    );
  }
  return { width: decoded.width, height: decoded.height, rgba: decoded.rgba, analysis };
}

export const BROWSER_CANDIDATES = {
  win32: [
    {
      name: 'chrome',
      label: 'Google Chrome',
      paths: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
      pathNames: ['chrome.exe'],
    },
    {
      name: 'chromium',
      label: 'Chromium',
      paths: [],
      pathNames: ['chromium.exe'],
    },
    {
      name: 'edge',
      label: 'Microsoft Edge',
      paths: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      pathNames: ['msedge.exe'],
    },
  ],
  darwin: [
    {
      name: 'chrome',
      label: 'Google Chrome',
      paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      pathNames: ['google-chrome'],
    },
    {
      name: 'chromium',
      label: 'Chromium',
      paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      pathNames: ['chromium'],
    },
    {
      name: 'edge',
      label: 'Microsoft Edge',
      paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      pathNames: ['microsoft-edge'],
    },
  ],
  linux: [
    {
      name: 'chrome',
      label: 'Google Chrome',
      paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
      pathNames: ['google-chrome', 'google-chrome-stable'],
    },
    {
      name: 'chromium',
      label: 'Chromium',
      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
      pathNames: ['chromium', 'chromium-browser'],
    },
    {
      name: 'edge',
      label: 'Microsoft Edge',
      paths: ['/usr/bin/microsoft-edge'],
      pathNames: ['microsoft-edge'],
    },
  ],
};

export const CLI_TOOL_BUILDERS = {
  resvg: (svg, size, out) => ['--width', String(size), '--height', String(size), svg, out],
  'rsvg-convert': (svg, size, out) => ['-w', String(size), '-h', String(size), '-o', out, svg],
  inkscape: (svg, size, out) => [
    svg,
    '--export-type=png',
    `--export-filename=${out}`,
    '-w',
    String(size),
    '-h',
    String(size),
  ],
  magick: (svg, size, out, viewBoxSize) => [
    '-background',
    'none',
    '-density',
    String(Math.max(1, Math.round((72 * size) / Math.max(viewBoxSize, size)))),
    svg,
    `PNG32:${out}`,
  ],
};

/**
 * Find available renderers. Pure: `exists` decides whether a path is there,
 * `pathValue` is a PATH-style string, `platform` a process.platform value.
 * Returns every candidate in preference order (browsers first, then CLI
 * tools) with its checked locations and what was found, plus the chosen
 * default: the first browser beats every CLI tool.
 */
export function discoverRenderers({ platform = process.platform, pathValue = '', exists = (p) => fs.existsSync(p) } = {}) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const extension = platform === 'win32' ? '.exe' : '';
  const pathDirs = pathValue.split(delimiter).filter((dir) => dir.trim() !== '');
  const browserSpecs = BROWSER_CANDIDATES[platform] ?? BROWSER_CANDIDATES.linux;

  const candidates = [];
  for (const spec of browserSpecs) {
    const checked = [...spec.paths, ...spec.pathNames.map((n) => `PATH:${n}${platform === 'win32' && !n.toLowerCase().endsWith('.exe') ? '.exe' : ''}`)];
    const found = findExecutable(spec.paths, spec.pathNames, pathDirs, extension, platform, exists);
    candidates.push({ name: spec.name, label: spec.label, kind: 'browser', checked, found });
  }
  for (const tool of Object.keys(CLI_TOOL_BUILDERS)) {
    const names = platform === 'win32' ? [`${tool}.exe`, tool] : [tool];
    const found = findExecutable([], names, pathDirs, extension, platform, exists);
    candidates.push({ name: tool, label: tool, kind: 'cli', checked: names.map((n) => `PATH:${n}`), found });
  }

  const firstBrowser = candidates.find((candidate) => candidate.kind === 'browser' && candidate.found);
  const firstTool = candidates.find((candidate) => candidate.kind === 'cli' && candidate.found);
  const winner = firstBrowser ?? firstTool ?? null;
  const chosen = winner ? { name: winner.name, label: winner.label, kind: winner.kind, ...winner.found } : null;
  return { platform, pathDirs: pathDirs.length, candidates, chosen };
}

function findExecutable(wellKnownPaths, names, pathDirs, extension, platform, exists) {
  for (const candidate of wellKnownPaths) {
    if (exists(candidate)) return { path: candidate, origin: 'install location' };
  }
  // Join with the *simulated* platform's separator: path.join would use the
  // host's, which breaks simulating Linux discovery from Windows and back.
  const separator = platform === 'win32' ? '\\' : '/';
  for (const dir of pathDirs) {
    const base = dir.endsWith(separator) || dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}${separator}`;
    for (const name of names) {
      const withExt = platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}${extension}` : name;
      const candidate = `${base}${withExt}`;
      if (exists(candidate)) return { path: candidate, origin: `PATH (${dir})` };
    }
  }
  return null;
}

export function noRendererMessage() {
  return [
    'No SVG renderer found.',
    'I looked for Chrome, Chromium and Edge (well-known install locations and PATH),',
    'then for resvg, rsvg-convert, inkscape and magick on PATH.',
    'Install Google Chrome (https://www.google.com/chrome/) or Microsoft Edge,',
    'or one of the command-line renderers above, then run "doctor" again.',
  ].join('\n');
}

/** Run a command with no visible window and resolve its exit code. */
export function runHidden(command, args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: false });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ code: null, timedOut: true });
      }
    }, timeoutMs);
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, error: error.message });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      }
    });
  });
}

/**
 * Page for one render: the SVG referenced as an <img> of exactly `size` CSS
 * pixels on a transparent page. Browsers rasterize an SVG image at its layout
 * size, so every size is rendered from the vector source (never downscaled),
 * and SVG-as-image is the locked-down mode: scripts inside the SVG can never
 * run. (An inline SVG sized with vw/vh CSS produced deterministic partial
 * rasterization in Chrome 154 on this machine — see the report.)
 */
export function renderPageHtml(svgUrl, size) {
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;overflow:hidden}img{display:block}</style>',
    `<img src="${svgUrl}" style="width:${size}px;height:${size}px">`,
  ].join('\n');
}

let profileCounter = 0;

/**
 * Render one SVG to a PNG of exactly `size` px with a transparent background.
 * The user's `outPath` is never touched until the render exists, has the
 * exact pixel size and transparent corners (or `force` is set for an
 * overwrite). `tempDir` must already exist and holds the throwaway browser
 * profile, the HTML page and the scratch PNG.
 */
export async function renderSvgPng({ svgPath, size, outPath, renderer, tempDir, force = false, log = () => {} }) {
  outPath = resolveOutputFile(outPath).path;
  svgPath = resolveInputFile(svgPath).path;
  if (!force && fs.existsSync(outPath)) {
    throw new Error(`${outPath} already exists; pass --force to overwrite it`);
  }
  let outStat = null;
  try {
    outStat = fs.lstatSync(outPath);
  } catch {
    outStat = null;
  }
  if (outStat !== null && outStat.isSymbolicLink()) {
    throw new Error(`${outPath} is a symbolic link: refusing to write through it`);
  }
  const svgText = fs.readFileSync(svgPath, 'utf8');
  const validation = validateSvg(svgText, { label: svgPath });
  if (!validation.ok) {
    throw new Error(`${svgPath} cannot be rendered:\n  - ${validation.errors.join('\n  - ')}`);
  }
  const scratchPath = path.join(tempDir, `out-${size}-${process.pid}-${(profileCounter += 1)}.png`);
  if (renderer.kind === 'browser') {
    await renderWithBrowser({ svgPath, size, outPath: scratchPath, renderer, tempDir, log });
  } else {
    await renderWithTool({ svgPath, size, outPath: scratchPath, renderer, viewBoxSize: validation.viewBox.width, log });
  }
  const verified = verifyRenderedPng(fs.readFileSync(scratchPath), size, { label: `${renderer.label} (${svgPath})` });
  // Publish by replacing the directory entry through an exclusively created
  // staging file, never by writing through an existing entry: an alias at
  // the target (or at the staging name) must not carry the bytes somewhere
  // the user did not name.
  publishExclusive(outPath, fs.readFileSync(scratchPath));
  fs.rmSync(scratchPath, { force: true });
  return verified;
}

async function renderWithBrowser({ svgPath, size, outPath, renderer, tempDir, log }) {
  await screenshotPage({
    html: renderPageHtml(pathToFileURL(path.resolve(svgPath)).href, size),
    width: size,
    height: size,
    outPath,
    renderer,
    tempDir,
    log,
  });
}

const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Screenshot an HTML page of exactly width x height CSS pixels (transparent
 * page background) into `outPath`. Used for SVG renders and for decoding
 * raster images with the browser's own decoders.
 */
async function screenshotPage({ html, width, height, outPath, renderer, tempDir, log }) {
  const htmlPath = path.join(tempDir, `render-${width}x${height}-${process.pid}-${profileCounter += 1}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.rmSync(outPath, { force: true });

  // The chrome.exe launcher may exit immediately after handing the command
  // line to a de-elevated child (observed on Windows when the caller is
  // elevated): the launcher exits in ~100 ms and the child writes the
  // screenshot ~500 ms later. The exit code says nothing, so the output file
  // is the only signal that matters — poll for it after the process ends.
  const waitForPng = async (deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(outPath)) {
        try {
          const bytes = fs.readFileSync(outPath);
          const info = pngInfo(bytes);
          // A complete file ends with the IEND chunk; the IHDR alone appears
          // long before a large screenshot has been written out.
          if (bytes.length >= 8 && bytes.subarray(bytes.length - 8).equals(PNG_IEND)) {
            if (info.width === width && info.height === height) return null;
            return `wrote a ${info.width}x${info.height} PNG (wanted ${width}x${height})`;
          }
        } catch (error) {
          // The file may still be mid-write; keep polling.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return 'wrote no screenshot';
  };

  const attempt = async (profileDir) => {
    const args = [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      // Harmless on a normal shell; asked for explicitly because Chrome
      // started from an elevated process otherwise de-elevates into a
      // detached child.
      '--no-deelevate',
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--screenshot=${path.resolve(outPath)}`,
      pathToFileURL(htmlPath).href,
    ];
    const result = await runHidden(renderer.path, args);
    if (result.error) return result.error;
    return waitForPng(result.timedOut ? 1000 : 20000);
  };

  let problem = await attempt(path.join(tempDir, 'browser-profile'));
  if (problem !== null) {
    log(`${renderer.label} attempt failed (${problem}); retrying with a fresh profile`);
    problem = await attempt(path.join(tempDir, `browser-profile-${Date.now()}`));
  }
  fs.rmSync(htmlPath, { force: true });
  if (problem !== null) {
    throw new Error(`${renderer.label} could not render ${width}x${height}px: ${problem}`);
  }
}

/** Largest side the browser is asked to decode at (bigger sources are shrunk by the browser). */
export const BROWSER_DECODE_MAX = 2048;

/** Size at which the browser shows (and so decodes) a width x height source. */
export function browserDecodeSize(width, height) {
  const scale = Math.min(1, BROWSER_DECODE_MAX / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decode a JPEG/WebP/BMP/PNG with the headless browser: the file is shown as
 * an <img> at 1:1 (EXIF orientation switched off, so the pixels match the
 * header dimensions) and screenshotted. Sources larger than
 * BROWSER_DECODE_MAX are shown scaled down to it. The image is only ever
 * displayed as a picture; nothing in it runs. Returns { width, height, rgba }.
 */
// The load verdict travels in one extra pixel row under the picture: our own
// three-line script paints it green when the browser reports a decoded image
// and leaves it magenta otherwise (error event, zero size, script not run).
const LOAD_OK = [0, 255, 0];

export function decodePageHtml(imageUrl, width, height) {
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0;overflow:hidden}img{display:block;image-orientation:none}',
    `#verdict{position:absolute;left:0;top:${height}px;width:${width}px;height:1px;background:rgb(255,0,255)}</style>`,
    `<img id="picture" src="${imageUrl}" style="width:${width}px;height:${height}px">`,
    '<div id="verdict"></div>',
    '<script>',
    '(function () {',
    '  var picture = document.getElementById("picture");',
    '  function judge() {',
    '    if (picture.complete && picture.naturalWidth > 0 && picture.naturalHeight > 0) {',
    '      document.getElementById("verdict").style.background = "rgb(0,255,0)";',
    '    }',
    '  }',
    '  if (picture.complete) judge(); else picture.addEventListener("load", judge);',
    '})();',
    '</script>',
  ].join('\n');
}

export async function decodeImageWithBrowser({ imagePath, width, height, renderer, tempDir, log = () => {} }) {
  if (renderer.kind !== 'browser') {
    throw new Error(
      `decoding this image format needs a headless browser (Chrome, Chromium or Edge) and ${renderer.label} is not one; ` +
        'convert the image to PNG first or install a browser',
    );
  }
  const { width: shownWidth, height: shownHeight } = browserDecodeSize(width, height);
  const outPath = path.join(tempDir, `decode-${process.pid}-${profileCounter += 1}.png`);
  const html = decodePageHtml(pathToFileURL(path.resolve(imagePath)).href, shownWidth, shownHeight);
  await screenshotPage({ html, width: shownWidth, height: shownHeight + 1, outPath, renderer, tempDir, log });
  const shot = decodePng(fs.readFileSync(outPath));
  fs.rmSync(outPath, { force: true });
  // Every pixel of the verdict row must be green: a failed or half-loaded
  // image leaves it magenta, and a decode that produced the wrong size is
  // refused as well.
  const verdictRow = shot.rgba.subarray(shownHeight * shownWidth * 4);
  for (let x = 0; x < shownWidth; x += 1) {
    const o = x * 4;
    if (verdictRow[o] !== LOAD_OK[0] || verdictRow[o + 1] !== LOAD_OK[1] || verdictRow[o + 2] !== LOAD_OK[2] || verdictRow[o + 3] !== 255) {
      throw new Error(
        `the browser could not decode ${path.basename(imagePath)}: the file is corrupt, truncated or not really the image format its header claims`,
      );
    }
  }
  return { width: shot.width, height: shownHeight, rgba: shot.rgba.subarray(0, shownWidth * shownHeight * 4) };
}

async function renderWithTool({ svgPath, size, outPath, renderer, viewBoxSize, log }) {
  const buildArgs = CLI_TOOL_BUILDERS[renderer.name];
  const absoluteSvg = path.resolve(svgPath);
  const absoluteOut = path.resolve(outPath);
  const result = await runHidden(renderer.path, buildArgs(absoluteSvg, size, absoluteOut, viewBoxSize));
  let ok = result.code === 0 && fs.existsSync(absoluteOut);
  if (!ok && renderer.name === 'magick') {
    // ImageMagick's SVG delegate may round the -density render off by a pixel;
    // an exact resize of its own output is still better than failing.
    log('magick produced no exact-size output; retrying with an exact resize');
    const retry = await runHidden(renderer.path, [
      '-background',
      'none',
      absoluteSvg,
      '-resize',
      `${size}x${size}!`,
      `PNG32:${absoluteOut}`,
    ]);
    ok = retry.code === 0 && fs.existsSync(absoluteOut);
  }
  if (!ok) {
    throw new Error(
      `${renderer.label} could not render ${svgPath} at ${size}px ` +
        `(exit ${result.code ?? 'n/a'}${result.timedOut ? ', timed out' : ''}${result.error ? `, ${result.error}` : ''})`,
    );
  }
}
