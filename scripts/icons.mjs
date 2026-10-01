#!/usr/bin/env node
// icon-creator tool: render, inspect and export application icons from SVG.
//
// Subcommands: doctor, import, render, sheet, check, export. Run with --help (or a
// subcommand --help) for details. Node 18+, no npm dependencies, no network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRenderers, renderSvgPng, noRendererMessage, decodeImageWithBrowser } from './lib/renderers.mjs';
import { renderSheet, DEFAULT_SHEET_SIZES, DEFAULT_CHECK_SIZES } from './lib/sheet.mjs';
import { runExport, TARGETS } from './lib/export.mjs';
import { importImage, describeImport, DEFAULT_TOLERANCE, BACKGROUND_MODES } from './lib/importimg.mjs';

const USAGE = `icon-creator: design-time icon toolchain for app icons (no dependencies)

Usage
  node icons.mjs doctor [--offline]
      Print the renderers found on this machine (browsers first, then
      resvg, rsvg-convert, inkscape, magick) and, unless --offline is
      given, prove the pipeline with a live 16 px test render.

  node icons.mjs import <image> --out <dir> --name <name> [options]
      Prepare YOUR OWN image (PNG, JPEG, WebP, GIF first frame, BMP or SVG)
      as a master: a square transparent PNG (1024 px, smaller if the source
      is smaller, never enlarged) plus a wrapper <name>-master.svg that
      check, sheet, render and export accept. Nothing is stretched or
      cropped. Prints measured facts and honest warnings.
      Options: --background auto|keep|remove (default auto: keep a
      transparent background, remove a plain one, keep and warn otherwise),
      --tolerance 0-120 (colour distance counted as background, default
      ${DEFAULT_TOLERANCE}), --force (overwrite).

  node icons.mjs render <file.svg> --size <px> --out <file.png>
      Render one SVG to a transparent PNG of exactly that pixel size and
      print corner alpha, visible-ink and bounding-box measurements.

  node icons.mjs sheet <a.svg> [b.svg ...] --out <sheet.png> [--sizes 256,64,32,16]
      One screenshot with every SVG at every size, on a light and a dark
      background (rows: sizes, top to bottom; columns: SVGs, left to right).

  node icons.mjs check <file.svg> [--small <file.svg>] --out <sheet.png>
      The small-size review: 48/32/16 px on light and dark backgrounds plus
      printed measurements of the transparent 16 px render.

  node icons.mjs export <file.svg> --out <dir> --name <name> [options]
      Build the whole set: windows <name>.ico, macos <name>.icns, the Linux
      hicolor tree + .desktop snippet, web favicons + manifest + head
      snippet, and the master icon.svg / icon-1024.png.
      Options: --title "App Name" (manifest/desktop display name),
      --small <file.svg> (simplified variant used for sizes <= 32 px),
      --only master,windows,macos,linux,web (subset), --force (overwrite).

  Every command that writes a file refuses to replace an existing one unless
  you pass --force; export also refuses to write into a non-empty output
  folder without --force.

  Common option: --renderer chrome|chromium|edge|resvg|rsvg-convert|inkscape|magick

Exit codes: 0 success, 1 failure (message on stderr), 2 usage error.
`;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function parseArgs(argv) {
  const options = { _: [] };
  const valueFlags = new Set(['--size', '--out', '--sizes', '--name', '--title', '--small', '--only', '--renderer', '--background', '--tolerance']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.split('=', 2);
      if (!valueFlags.has(name)) {
        if (inlineValue !== undefined) throw new Error(`${name} does not take a value`);
        options[name.slice(2)] = true;
        continue;
      }
      const value = inlineValue !== undefined ? inlineValue : argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
      options[name.slice(2)] = value;
    } else {
      options._.push(arg);
    }
  }
  return options;
}

function parseSizes(text, fallback) {
  if (!text) return fallback;
  const sizes = text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((size) => Number.isInteger(size) && size >= 8 && size <= 2048);
  if (sizes.length === 0) throw new Error(`--sizes "${text}" has no whole sizes between 8 and 2048`);
  return sizes;
}

function makeTempBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-'));
  const cleanup = () => {
    try {
      // A browser that was just stopped can hold profile files for a few
      // seconds, longer when several commands run at once.
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
    } catch {
      // best effort: the folder sits in the OS temp dir if the browser is
      // still releasing files; it contains nothing but scratch data
    }
  };
  process.on('exit', cleanup);
  return { base, cleanup };
}

function pickRenderer(discovery, wanted) {
  if (!wanted) return discovery.chosen;
  const available = discovery.candidates.filter((candidate) => candidate.found);
  const match = available.find((candidate) => candidate.name === wanted || candidate.label === wanted);
  if (!match) {
    throw new Error(
      `--renderer ${wanted} was not found on this machine. Available: ` +
        (available.map((candidate) => candidate.name).join(', ') || 'none') +
        '.',
    );
  }
  // Keep the candidate metadata: kind decides the launch path, label names
  // the renderer in messages.
  return { name: match.name, label: match.label, kind: match.kind, ...match.found };
}

const log = (message) => process.stdout.write(`${message}\n`);

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let options;
  try {
    options = parseArgs(rest);
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`, 2);
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (subcommand === 'doctor') {
    return doctor(options);
  }
  if (subcommand === 'import') {
    return importCommand(options);
  }
  if (subcommand === 'render') {
    return renderOne(options);
  }
  if (subcommand === 'sheet') {
    return sheet(options);
  }
  if (subcommand === 'check') {
    return check(options);
  }
  if (subcommand === 'export') {
    return exportAll(options);
  }
  fail(`Unknown subcommand "${subcommand}".\n\n${USAGE}`, 2);
}

async function doctor(options) {
  const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  log(`node ${process.version} on ${process.platform}`);
  log('Browsers (in preference order):');
  for (const candidate of discovery.candidates.filter((c) => c.kind === 'browser')) {
    log(`  ${candidate.label} -> ${candidate.found ? `${candidate.found.path} (${candidate.found.origin})` : 'not found'}`);
  }
  log('Command-line renderers:');
  for (const candidate of discovery.candidates.filter((c) => c.kind === 'cli')) {
    log(`  ${candidate.label} -> ${candidate.found ? `${candidate.found.path} (${candidate.found.origin})` : 'not found'}`);
  }
  if (!discovery.chosen) {
    fail(`\n${noRendererMessage()}`);
    return;
  }
  log(`\nDefault renderer: ${discovery.chosen.label} (${discovery.chosen.path})`);
  if (options.offline) return;
  const { base, cleanup } = makeTempBase();
  try {
    const testSvg = path.join(base, 'doctor.svg');
    fs.writeFileSync(
      testSvg,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
        '<rect x="48" y="48" width="160" height="160" rx="40" fill="#4F46E5"/>' +
        '<circle cx="128" cy="128" r="44" fill="#F9FAFB"/></svg>',
    );
    const out = path.join(base, 'doctor.png');
    const analysis = await renderSvgPng({ svgPath: testSvg, size: 16, outPath: out, renderer: discovery.chosen, tempDir: base, log });
    const corners = analysis.analysis.cornerAlphas.join(' ');
    log(`Live test: rendered 16 px, corners transparent (alpha ${corners}) -> renderer works.`);
  } catch (error) {
    fail(`Live test render failed: ${error.message}`);
  } finally {
    cleanup();
  }
}

async function importCommand(options) {
  const [srcPath, ...extra] = options._;
  if (!srcPath || !options.out || !options.name) {
    fail('import needs <image file>, --out <dir> and --name <name>', 2);
    return;
  }
  if (extra.length > 0) {
    fail('import takes exactly one image file', 2);
    return;
  }
  const background = options.background ?? 'auto';
  if (!BACKGROUND_MODES.includes(background)) {
    fail(`--background must be one of ${BACKGROUND_MODES.join(', ')}`, 2);
    return;
  }
  const tolerance = options.tolerance === undefined ? DEFAULT_TOLERANCE : Number(options.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 120) {
    fail('--tolerance must be a number from 0 to 120', 2);
    return;
  }
  const { base, cleanup } = makeTempBase();
  try {
    // The browser is only needed for JPEG, WebP and BMP: find it on demand.
    const browserDecode = async ({ imagePath, width, height }) => {
      const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
      const renderer = pickRenderer(discovery, options.renderer);
      if (!renderer) throw new Error(noRendererMessage());
      return decodeImageWithBrowser({ imagePath, width, height, renderer, tempDir: base });
    };
    const result = await importImage({
      srcPath,
      outDir: path.resolve(options.out),
      name: options.name,
      background,
      tolerance,
      force: Boolean(options.force),
      browserDecode,
    });
    for (const line of describeImport(result)) log(line);
    for (const file of result.files) log(`Wrote ${file.path} (${file.bytes} bytes)`);
    const wrapper = result.files.find((file) => file.path.endsWith('.svg'));
    log(`Use ${wrapper.path} with check, sheet, render and export.`);
    if (result.warnings.length > 0) {
      log(`\nWarnings (${result.warnings.length}):`);
      for (const warning of result.warnings) log(`  - [${warning.code}] ${warning.message}`);
    } else {
      log('\nWarnings: none from the automatic measurements - still look at the picture.');
    }
  } catch (error) {
    fail(error.message);
  } finally {
    cleanup();
  }
}

async function renderOne(options) {
  const [svgPath] = options._;
  if (!svgPath || !options.size || !options.out) {
    fail('render needs <file.svg>, --size <px> and --out <file.png>', 2);
    return;
  }
  const size = Number(options.size);
  if (!Number.isInteger(size) || size < 8 || size > 2048) {
    fail('--size must be a whole number between 8 and 2048', 2);
    return;
  }
  const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  let renderer;
  try {
    renderer = pickRenderer(discovery, options.renderer);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!renderer) {
    fail(noRendererMessage());
    return;
  }
  const { base, cleanup } = makeTempBase();
  try {
    const analysis = await renderSvgPng({
      svgPath,
      size,
      outPath: path.resolve(options.out),
      renderer,
      tempDir: base,
      force: Boolean(options.force),
      log,
    });
    const a = analysis.analysis;
    log(
      `${options.out}: ${analysis.width}x${analysis.height}, corners alpha [${a.cornerAlphas.join(' ')}], ` +
        `visible ink ${(100 * a.visibleRatio).toFixed(1)}%, ink box ${a.bbox ? `${a.bbox.width}x${a.bbox.height} at (${a.bbox.x},${a.bbox.y})` : 'none'}.`,
    );
  } catch (error) {
    fail(error.message);
  } finally {
    cleanup();
  }
}

async function sheet(options) {
  const svgPaths = options._;
  if (svgPaths.length === 0 || !options.out) {
    fail('sheet needs at least one <file.svg> and --out <sheet.png>', 2);
    return;
  }
  const sizes = parseSizes(options.sizes, DEFAULT_SHEET_SIZES);
  const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  let renderer;
  try {
    renderer = pickRenderer(discovery, options.renderer);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!renderer) {
    fail(noRendererMessage());
    return;
  }
  const { base, cleanup } = makeTempBase();
  try {
    await renderSheet({
      svgPaths: svgPaths.map((p) => path.resolve(p)),
      outPath: path.resolve(options.out),
      renderer,
      tempDir: base,
      sizes,
      force: Boolean(options.force),
      log: () => {},
    });
    log(`${options.out}: ${svgPaths.length} SVG(s) x ${sizes.length} sizes (${sizes.join(', ')}) on light and dark backgrounds.`);
  } catch (error) {
    fail(error.message);
  } finally {
    cleanup();
  }
}

async function check(options) {
  const [svgPath, ...extra] = options._;
  if (!svgPath || !options.out) {
    fail('check needs <file.svg> and --out <sheet.png>', 2);
    return;
  }
  if (extra.length > 0) {
    fail('check takes exactly one SVG (plus --small for a variant)', 2);
    return;
  }
  const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  let renderer;
  try {
    renderer = pickRenderer(discovery, options.renderer);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!renderer) {
    fail(noRendererMessage());
    return;
  }
  const { base, cleanup } = makeTempBase();
  try {
    const metricsOut = path.join(base, 'metric-16.png');
    const metrics = await renderSvgPng({ svgPath: path.resolve(svgPath), size: 16, outPath: metricsOut, renderer, tempDir: base, log: () => {} });
    const m = metrics.analysis;
    log(`16 px transparent render: corners alpha [${m.cornerAlphas.join(' ')}], visible ink ${(100 * m.visibleRatio).toFixed(1)}%, ink box ${m.bbox ? `${m.bbox.width}x${m.bbox.height}` : 'none'}.`);
    const hints = [];
    if (!m.bbox) hints.push('the icon is INVISIBLE at 16 px: the motif vanished. Simplify it or provide a small variant.');
    else {
      if (m.cornerAlphas.some((alpha) => alpha > 0)) hints.push('corners are not transparent: the icon paints to the very edge of the canvas.');
      if (m.visibleRatio < 0.12) hints.push('very little ink at 16 px: strokes or details are hairline-thin at this size.');
      if (m.bbox.width / 16 < 0.5) hints.push('the ink box covers under half the canvas at 16 px: the motif is too small in its container.');
      if (m.bbox.width / 16 > 0.99 && m.visibleRatio > 0.97) hints.push('the canvas is nearly full-bleed: consider a container with padding.');
    }
    const svgPaths = [path.resolve(svgPath)];
    if (options.small) svgPaths.push(path.resolve(options.small));
    await renderSheet({
      svgPaths,
      outPath: path.resolve(options.out),
      renderer,
      tempDir: base,
      sizes: DEFAULT_CHECK_SIZES,
      force: Boolean(options.force),
      log: () => {},
    });
    log(`Review sheet: ${options.out} (${svgPaths.length === 2 ? 'master and small variant, ' : ''}48/32/16 px, light and dark backgrounds).`);
    if (hints.length > 0) {
      log('Notes:');
      for (const hint of hints) log(`  - ${hint}`);
    } else {
      log('Notes: none — metrics look healthy. Judge legibility on the sheet.');
    }
  } catch (error) {
    fail(error.message);
  } finally {
    cleanup();
  }
}

async function exportAll(options) {
  const [svgPath] = options._;
  if (!svgPath || !options.out || !options.name) {
    fail('export needs <file.svg>, --out <dir> and --name <name>', 2);
    return;
  }
  const targets = options.only ? options.only.split(',').map((t) => t.trim()).filter(Boolean) : TARGETS;
  const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  let renderer;
  try {
    renderer = pickRenderer(discovery, options.renderer);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!renderer) {
    fail(noRendererMessage());
    return;
  }
  const outDir = path.resolve(options.out);
  const { base, cleanup } = makeTempBase();
  const workDir = path.join(base, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const result = await runExport({
      svgPath: path.resolve(svgPath),
      smallPath: options.small ? path.resolve(options.small) : null,
      outDir,
      name: options.name,
      title: options.title,
      targets,
      force: Boolean(options.force),
      render: (svg, size, pngPath) => renderSvgPng({ svgPath: svg, size, outPath: pngPath, renderer, tempDir: base, log: () => {} }),
      workDir,
      log,
    });
    log(`\nExported ${result.files.length} files to ${outDir} (name "${result.name}", title "${result.title}", targets: ${targets.join(', ')}).`);
    for (const file of result.files) log(`  ${file.rel} (${file.bytes} bytes)`);
    if (result.rasterMaster) {
      log(
        `
Not written, because the master is a raster image and no honest vector file exists: ${result.skipped.join(', ') || 'nothing (those targets were not requested)'}.`,
      );
    }
  } catch (error) {
    fail(error.message);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  fail(error.stack ?? error.message);
});
