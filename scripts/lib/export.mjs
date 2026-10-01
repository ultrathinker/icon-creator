// The export step: turn one master SVG (optionally a simplified variant for
// tiny sizes) into the full desktop + web icon set. All renders happen in a
// scratch work dir; the output folder only receives finished files, and only
// after the overwrite check has passed.

import fs from 'node:fs';
import path from 'node:path';
import { validateSvg } from './svgcheck.mjs';
import { verifyRenderedPng } from './renderers.mjs';
import { publishExclusive, assertRealAncestors } from './publish.mjs';
import { buildIco } from './ico.mjs';
import { buildIcns } from './icns.mjs';

export const TARGETS = ['master', 'windows', 'macos', 'linux', 'web'];

// Sizes <= 32 px are rendered from the small variant when one is given.
export const SMALL_MAX = 32;

export function sanitizeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      `"${name}" is not a safe file name: use 1-64 characters from letters, digits, ".", "_", "-", ` +
        'starting with a letter or digit (no path separators, no spaces)',
    );
  }
  return name;
}

export function titleOrDefault(name) {
  const spaced = name.replaceAll('-', ' ').replaceAll('_', ' ').replaceAll('.', ' ');
  return spaced
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanText(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').trim();
}

export function webmanifestText(title, name) {
  const manifest = {
    name: cleanText(title),
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function headHtmlText({ vector = true } = {}) {
  return [
    '<!-- Paste into the <head> of every page. Adjust the paths if the icons',
    '     do not live at the root of your site. -->',
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    ...(vector ? ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">'] : []),
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    '',
  ].join('\n');
}

export function desktopEntryText(title, name) {
  return [
    `# ${name}.desktop — copy to ~/.local/share/applications/ (all users:`,
    '# /usr/share/applications/) and copy the hicolor/ tree next to your theme',
    '# icons (~/.local/share/icons/ or /usr/share/icons/). Adjust Exec to the',
    '# real command that starts the application.',
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${cleanText(title)}`,
    `Exec=${name}`,
    `Icon=${name}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n');
}

export const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const MACOS_ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
export const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 192, 256, 512];
export const WEB_PNG_SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
export const FAVICON_ICO_SIZES = [16, 32, 48];

// Elements that only structure a document; anything else draws.
const STRUCTURAL_ELEMENTS = new Set(['svg', 'defs', 'g', 'title', 'desc', 'metadata']);

/**
 * True when the master SVG draws nothing but embedded raster images (the
 * wrapper `import` writes around a user's PNG/JPEG/...). Such a file is not
 * a vector source, so the export must not publish it as `icon.svg`,
 * `favicon.svg` or a scalable Linux icon.
 */
export function isRasterMaster(elements) {
  const drawing = elements.filter((element) => !STRUCTURAL_ELEMENTS.has(element));
  return drawing.length > 0 && drawing.every((element) => element === 'image');
}

/**
 * Plan every output file (relative paths, in a stable order) for the chosen
 * targets. Pure: no file system access. With `vector: false` (a raster
 * master) the files that would pretend to be vector are left out.
 */
export function planFiles(name, targets, { vector = true } = {}) {
  const files = [];
  const wants = (target) => targets.includes(target);
  if (wants('master')) {
    if (vector) files.push({ rel: 'icon.svg', kind: 'svg-copy' });
    files.push({ rel: 'icon-1024.png', kind: 'png', size: 1024 });
  }
  if (wants('windows')) {
    files.push({ rel: `windows/${name}.ico`, kind: 'ico', sizes: WINDOWS_ICO_SIZES });
  }
  if (wants('macos')) {
    files.push({ rel: `macos/${name}.icns`, kind: 'icns', sizes: MACOS_ICNS_SIZES });
  }
  if (wants('linux')) {
    for (const size of LINUX_SIZES) {
      files.push({ rel: `linux/hicolor/${size}x${size}/apps/${name}.png`, kind: 'png', size });
    }
    if (vector) files.push({ rel: `linux/scalable/apps/${name}.svg`, kind: 'svg-copy' });
    files.push({ rel: `linux/${name}.desktop`, kind: 'desktop' });
  }
  if (wants('web')) {
    if (vector) files.push({ rel: 'web/favicon.svg', kind: 'svg-copy' });
    files.push({ rel: 'web/favicon.ico', kind: 'ico', sizes: FAVICON_ICO_SIZES });
    for (const [file, size] of Object.entries(WEB_PNG_SIZES)) {
      files.push({ rel: `web/${file}`, kind: 'png', size });
    }
    files.push({ rel: 'web/site.webmanifest', kind: 'webmanifest' });
    files.push({ rel: 'web/head.html', kind: 'head' });
  }
  return files;
}

/**
 * Create `relativeDir` under `outDir`, refusing to follow symbolic links or
 * junctions: anything below the output root must be a real directory, so a
 * planted link cannot redirect writes outside the folder the user named. The
 * root itself may be a link the user deliberately chose.
 */
export function ensureRealDir(outDir, relativeDir) {
  // Every existing ancestor of the output root must be a real directory:
  // creating the root recursively through a symlinked parent would place the
  // whole export outside the path the user named. The root itself may be a
  // link the user deliberately chose (the realpath containment below then
  // anchors everything inside it).
  assertRealAncestors(outDir);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  } else if (!fs.statSync(outDir).isDirectory()) {
    throw new Error(`${outDir} exists and is not a directory`);
  }
  let current = outDir;
  for (const part of relativeDir.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, part);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null; // not there yet; create it below
    }
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${current} is a symbolic link or junction: refusing to follow it out of the output folder`,
        );
      }
      if (!stat.isDirectory()) {
        throw new Error(`${current} exists and is not a directory`);
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  const realRoot = fs.realpathSync(outDir);
  const realDir = fs.realpathSync(current);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`${current} resolves to ${realDir}, outside the output folder ${realRoot}`);
  }
}

/**
 * Publish a file inside the output folder: refuse a symbolic link at the
 * planned path, then publish through an exclusively created staging entry
 * that is renamed over the target. Writing through the existing entry (or
 * through a planted alias at the staging name) would follow a symlink or
 * carry the bytes through a hardlink to a file outside the folder the user
 * named; the exclusive create plus rename breaks both instead.
 */
export function publishFile(absolute, buffer) {
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = null; // not there yet
  }
  if (stat !== null && stat.isSymbolicLink()) {
    throw new Error(`${absolute} is a symbolic link: refusing to write through it out of the output folder`);
  }
  publishExclusive(absolute, buffer);
}

/**
 * Run the export. `render(svgPath, size, outPngPath)` must produce a
 * transparent PNG of exactly `size` px (the CLI passes the real renderer;
 * tests pass a fake). Every produced PNG is re-verified before it can enter
 * a container. Returns the list of written files.
 */
export async function runExport({ svgPath, smallPath = null, outDir, name, title = null, targets = TARGETS, force = false, render, workDir, log = () => {} }) {
  const safeName = sanitizeName(name);
  const safeTitle = cleanText(title ?? titleOrDefault(safeName));
  for (const target of targets) {
    if (!TARGETS.includes(target)) {
      throw new Error(`Unknown target "${target}" (known: ${TARGETS.join(', ')})`);
    }
  }

  const masterSvg = fs.readFileSync(svgPath, 'utf8');
  const masterCheck = validateSvg(masterSvg, { label: svgPath });
  if (!masterCheck.ok) {
    throw new Error(`${svgPath} cannot be exported:\n  - ${masterCheck.errors.join('\n  - ')}`);
  }
  let smallSvg = null;
  if (smallPath !== null) {
    smallSvg = fs.readFileSync(smallPath, 'utf8');
    const smallCheck = validateSvg(smallSvg, { label: smallPath });
    if (!smallCheck.ok) {
      throw new Error(`${smallPath} cannot be exported:\n  - ${smallCheck.errors.join('\n  - ')}`);
    }
  }

  fs.mkdirSync(workDir, { recursive: true });

  const vector = !isRasterMaster(masterCheck.elements);
  const plan = planFiles(safeName, targets, { vector });
  const skipped = vector
    ? []
    : planFiles(safeName, targets)
        .filter((file) => file.kind === 'svg-copy' && !plan.some((kept) => kept.rel === file.rel))
        .map((file) => file.rel);
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) {
      throw new Error(`${outDir} exists and is not a directory`);
    }
    const entries = fs.readdirSync(outDir);
    if (entries.length > 0 && !force) {
      const mine = plan.filter((file) => entries.includes(file.rel.split(/[\\/]/)[0])).map((file) => file.rel);
      const sample = (mine.length > 0 ? mine : entries).slice(0, 5).join(', ');
      throw new Error(
        `refusing to write into ${outDir}: the folder already holds ${entries.length} entr` +
          `${entries.length === 1 ? 'y' : 'ies'} (for example ${sample}). ` +
          'Pass --force to write into it anyway.',
      );
    }
  }

  // Render every needed (variant, size) pair once, into the work dir.
  const svgForSize = (size) => (smallSvg !== null && size <= SMALL_MAX ? smallPath : svgPath);
  const neededSizes = new Set();
  for (const file of plan) {
    if (file.kind === 'png') neededSizes.add(file.size);
    if (file.kind === 'ico') for (const size of file.sizes) neededSizes.add(size);
    if (file.kind === 'icns') for (const size of file.sizes) neededSizes.add(size);
  }
  const renders = new Map(); // "variant:size" -> png Buffer
  for (const size of [...neededSizes].sort((a, b) => a - b)) {
    const svg = svgForSize(size);
    const key = `${svg}:${size}`;
    if (renders.has(key)) continue;
    const pngPath = path.join(workDir, `render-${size}-${svg === svgPath ? 'main' : 'small'}.png`);
    log(`rendering ${size} px (${svg === svgPath ? 'master' : 'small variant'})`);
    await render(svg, size, pngPath);
    // Re-verify whatever the render function produced before it can enter
    // any container: exact size and transparent corners are hard invariants.
    const pngBuffer = fs.readFileSync(pngPath);
    verifyRenderedPng(pngBuffer, size, { label: `render step (${svg})` });
    renders.set(key, pngBuffer);
  }
  const pngFor = (size) => {
    const svg = svgForSize(size);
    const buffer = renders.get(`${svg}:${size}`);
    if (buffer === undefined) throw new Error(`internal error: no render for ${size} px`);
    return buffer;
  };

  const written = [];
  for (const file of plan) {
    const absolute = path.join(outDir, file.rel);
    ensureRealDir(outDir, path.dirname(file.rel));
    let buffer;
    switch (file.kind) {
      case 'svg-copy':
        buffer = Buffer.from(masterSvg, 'utf8');
        break;
      case 'png':
        buffer = pngFor(file.size);
        break;
      case 'ico':
        buffer = buildIco(file.sizes.map((size) => ({ size, png: pngFor(size) })));
        break;
      case 'icns': {
        const bySize = new Map(file.sizes.map((size) => [size, pngFor(size)]));
        buffer = buildIcns(bySize);
        break;
      }
      case 'webmanifest':
        buffer = Buffer.from(webmanifestText(safeTitle, safeName), 'utf8');
        break;
      case 'head':
        buffer = Buffer.from(headHtmlText({ vector }), 'utf8');
        break;
      case 'desktop':
        buffer = Buffer.from(desktopEntryText(safeTitle, safeName), 'utf8');
        break;
      default:
        throw new Error(`internal error: unknown file kind ${file.kind}`);
    }
    publishFile(absolute, buffer);
    written.push({ rel: file.rel, bytes: buffer.length });
  }
  return { outDir, name: safeName, title: safeTitle, targets, files: written, rasterMaster: !vector, skipped };
}
