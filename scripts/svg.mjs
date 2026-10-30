#!/usr/bin/env node
// svg.mjs — the SVG step: redraw ONE chosen candidate as a vector, then build its icon pack from the drawing.
//
//   node scripts/svg.mjs doctor
//   node scripts/svg.mjs measure --run <run folder> --number <k> [--rows 300,500] [--cols 512] [--colours 8]
//   node scripts/svg.mjs check   --run <run folder> --number <k> --svg <file.svg>
//   node scripts/svg.mjs pack    --run <run folder> --number <k> --svg <file.svg> [--name <name>] [--title <text>]
//
// Only `check`, `pack` and `doctor` start a renderer (Chrome, Edge, Chromium, or resvg / rsvg-convert / inkscape / magick),
// and only when they run; `measure` needs none. Every output stays inside the run folder, and nothing existing is
// overwritten: a second drawing gets the next free file name. The run folder path follows the rule of every named path:
// a link outside the current folder is followed once (a Note: line says so), a link inside it is refused.

import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from './lib/png.mjs';
import { prepareCandidate, buildPack, ensureRealDir, publishPackFile, sanitizeName, DEFAULT_TOLERANCE, DEFAULT_FILL } from './lib/packbuild.mjs';
import { MIN_FILL, MAX_FILL } from './lib/tightfit.mjs';
import { inferPackName } from './lib/runrecords.mjs';
import { resolveRunFolder, listCandidates } from './lib/runfolder.mjs';
import { measureMaster, compareToMaster, withRenderer } from './lib/svgstep.mjs';
import { validateSvg } from './lib/svgcheck.mjs';
import { resolveInputFile, linkNote } from './lib/publish.mjs';
import { discoverRenderers, noRendererMessage } from './lib/renderers.mjs';

const USAGE = `svg.mjs — redraw one chosen candidate as an SVG and build its pack

  node scripts/svg.mjs doctor
  node scripts/svg.mjs measure --run <run folder> --number <k> [--rows <y,y,...>] [--cols <x,x,...>] [--colours <2-16>]
  node scripts/svg.mjs check   --run <run folder> --number <k> --svg <file.svg>
  node scripts/svg.mjs pack    --run <run folder> --number <k> --svg <file.svg> [--name <name>] [--title <text>]

  Add the options the pack was built with so the master is the same one: [--fill <50-100>] [--no-crop] [--keep-tile]
  [--tolerance <0-120>] [--no-edge-clean].

doctor   looks for a renderer (Chrome, Edge or Chromium first; then resvg, rsvg-convert, inkscape, magick). check and pack need one.
measure  prints what is needed to redraw candidate <k> by numbers: the size to draw on, the shape's box, the flat colours
         with area, box and centre, the mirror symmetry, and scanlines (the runs of colour along rows and columns).
check    draws the SVG at the master's size and compares it with the master: mismatch percentages, the blocks that differ most,
         and svg-<k>-check.png (then -2, -3, ...: master | drawing | difference) in the run folder.
pack     builds pack-<k>-svg/ from the drawing (the full set rendered at 1024 px, plus icon.svg, web/favicon.svg and
         linux/hicolor/scalable/apps/<name>.svg). Never overwrites: a second pack is pack-<k>-svg-2.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    command: null, run: null, number: null, svg: null, name: null, title: null, rows: null, cols: null, colours: 8,
    tolerance: DEFAULT_TOLERANCE, fill: DEFAULT_FILL, crop: true, tile: 'crop', edgeClean: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (['doctor', 'measure', 'check', 'pack'].includes(arg)) {
      if (options.command !== null) throw new Error(`"${arg}" after "${options.command}": pick one command`);
      options.command = arg;
    } else if (arg === '--run') options.run = value();
    else if (arg === '--number') options.number = Number(value());
    else if (arg === '--svg') options.svg = value();
    else if (arg === '--name') options.name = value();
    else if (arg === '--title') options.title = value();
    else if (arg === '--rows') options.rows = numberList(arg, value());
    else if (arg === '--cols') options.cols = numberList(arg, value());
    else if (arg === '--colours') options.colours = Number(value());
    else if (arg === '--tolerance') options.tolerance = Number(value());
    else if (arg === '--fill') options.fill = Number(value()) / 100;
    else if (arg === '--no-crop') options.crop = false;
    else if (arg === '--keep-tile') options.tile = 'keep';
    else if (arg === '--no-edge-clean') options.edgeClean = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown option "${arg}"`);
  }
  if (options.command === null) throw new Error('pick a command: doctor, measure, check or pack');
  if (options.command === 'doctor') return options;
  if (options.run === null) throw new Error('--run <run folder> is required');
  if (!Number.isInteger(options.number) || options.number < 1) throw new Error('--number <k> is required: the number of the candidate (the k of candidate-k)');
  if ((options.command === 'check' || options.command === 'pack') && options.svg === null) throw new Error('--svg <file.svg> is required');
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 120) throw new Error('--tolerance must be a number from 0 to 120');
  if (!Number.isFinite(options.fill) || options.fill < MIN_FILL || options.fill > MAX_FILL) throw new Error(`--fill must be a percentage from ${MIN_FILL * 100} to ${MAX_FILL * 100}`);
  if (!Number.isInteger(options.colours) || options.colours < 2 || options.colours > 16) throw new Error('--colours must be a whole number from 2 to 16');
  if (options.title !== null && (options.title.trim() === '' || options.title.length > 80)) throw new Error('--title must be 1 to 80 characters');
  return options;
}

function numberList(flag, text) {
  if (!/^\d{1,5}(,\d{1,5}){0,63}$/.test(text)) throw new Error(`${flag} must be whole numbers separated by commas, for example 300,500,700 (at most 64)`);
  return text.split(',').map(Number);
}

/** The prepared master of candidate <number>: the same preparation the pack and the sheet use. */
function loadPrepared(options) {
  const resolved = resolveRunFolder(options.run, { reading: options.command === 'measure' });
  if (resolved.linked) process.stderr.write(`${linkNote('The run folder', resolved)}\n`);
  const runFolder = resolved.path;
  const candidate = listCandidates(runFolder).find((entry) => entry.index === options.number);
  if (candidate === undefined) throw new Error(`no candidate-${options.number} in ${runFolder}`);
  if (candidate.refused) throw new Error(`${candidate.file} is ${candidate.refused}, so it is refused`);
  if (candidate.format !== 'png') throw new Error(`candidate ${options.number} is ${candidate.format.toUpperCase()}; only PNG candidates can be measured`);
  const prepared = prepareCandidate(fs.readFileSync(path.join(runFolder, candidate.file)), {
    tolerance: options.tolerance,
    fill: options.fill,
    crop: options.crop,
    tile: options.tile,
    edgeClean: options.edgeClean,
  });
  return { runFolder, prepared };
}

/** The SVG text, read through the link-safe reader, validated; the error lists every problem. */
function loadSvg(typed) {
  const resolved = resolveInputFile(typed);
  const text = fs.readFileSync(resolved.path, 'utf8');
  const validation = validateSvg(text, { label: resolved.path });
  const errors = [...validation.errors];
  // The step draws shapes. A raster picture wrapped in an SVG (the checker allows an embedded data: image) would match the master
  // perfectly and be no vector at all, so it is refused here.
  if (/<(?:[A-Za-z_][\w.-]*:)?image[\s/>]/i.test(text)) errors.push('contains an <image> element: draw the shapes; a picture wrapped in an SVG is not a vector');
  if (errors.length > 0) throw new Error(`${resolved.path} cannot be used:\n  - ${errors.join('\n  - ')}`);
  return { path: resolved.path, text, validation };
}

/** The first file name `<stem>[-n]<suffix>` that does not exist in `dir`. */
function nextFree(dir, stem, suffix) {
  for (let n = 1; n < 1000; n += 1) {
    const name = `${stem}${n === 1 ? '' : `-${n}`}${suffix}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  throw new Error(`too many ${stem} files in ${dir}`);
}

function runDoctor() {
  const found = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
  if (!found.chosen) {
    process.stdout.write(`${JSON.stringify({ renderer: null }, null, 2)}\n`);
    return fail(noRendererMessage().replace('then run "doctor" again', 'then run this again'));
  }
  const { name, label, kind, path: executable, origin } = found.chosen;
  process.stdout.write(`${JSON.stringify({ renderer: { name, label, kind, path: executable, origin } }, null, 2)}\n`);
  return undefined;
}

function runMeasure(options) {
  const { prepared } = loadPrepared(options);
  const measured = measureMaster(prepared, { rows: options.rows, cols: options.cols, colours: options.colours });
  process.stdout.write(`${JSON.stringify({ candidate: options.number, ...measured }, null, 2)}\n`);
}

async function runCheck(options) {
  const { runFolder, prepared } = loadPrepared(options);
  const svg = loadSvg(options.svg);
  const { metrics, panel } = await withRenderer(async (render) => {
    const rendered = await render(svg.path, prepared.size);
    return compareToMaster(prepared.rgba, rendered, prepared.size);
  });
  const file = nextFree(runFolder, `svg-${options.number}-check`, '.png');
  publishPackFile(path.join(runFolder, file), panel);
  const result = { candidate: options.number, svg: svg.path, svgBytes: Buffer.byteLength(svg.text, 'utf8'), viewBox: svg.validation.viewBox, metrics, picture: path.join(runFolder, file) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runPack(options) {
  const { runFolder, prepared } = loadPrepared(options);
  const svg = loadSvg(options.svg);
  const MASTER = 1024;
  const drawn = await withRenderer((render) => render(svg.path, MASTER));
  // the picture is the drawing exactly as drawn: no crop, no cut-out, no edge cleaning
  const fromSvg = prepareCandidate(encodePng(MASTER, MASTER, drawn), { crop: false, edgeClean: false, background: 'keep' });
  const name = sanitizeName(options.name ?? inferPackName(runFolder) ?? 'app');
  const folder = nextFree(runFolder, `pack-${options.number}-svg`, '');
  const packDir = path.join(runFolder, folder);
  ensureRealDir(packDir);
  const pack = buildPack(fromSvg, {
    name,
    title: options.title,
    svg: svg.text,
    publish: (rel, buffer) => {
      const absolute = path.join(packDir, rel);
      ensureRealDir(path.dirname(absolute));
      publishPackFile(absolute, buffer);
    },
  });
  const result = { candidate: options.number, packDir, masterSize: pack.masterSize, svg: svg.path, usedRasterMasterOf: prepared.size, files: pack.files, omitted: pack.omitted, warnings: fromSvg.warnings };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'doctor') runDoctor();
  else if (options.command === 'measure') runMeasure(options);
  else if (options.command === 'check') await runCheck(options);
  else await runPack(options);
} catch (error) {
  fail(error.message);
}
