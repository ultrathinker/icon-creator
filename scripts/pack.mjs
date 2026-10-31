#!/usr/bin/env node
// pack.mjs — the candidates workflow: take a folder of pictures in as numbered candidates, build a finished icon
// pack for every candidate, and draw contact sheets that show them all at 64, 32 and 16 px.
//
//   node scripts/pack.mjs ingest --from <folder of pictures> --run <run folder> [--max 64]
//   node scripts/pack.mjs build --run <run folder> [--name app] [--fill 96] [--only 5-12] [--force]
//   node scripts/pack.mjs sheet --run <run folder> [--only 5-12] [--fill 96] [--force]
//
// Every output stays inside the run folder; the pictures ingest reads are never changed. Nothing is overwritten without
// --force. A link in a typed path that lies outside the current folder is followed once and a Note: line says so; a link
// inside the current folder, and any link below the run folder, is refused.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCandidate, buildPack, ensureRealDir, publishPackFile, sanitizeName, DEFAULT_TOLERANCE, DEFAULT_FILL } from './lib/packbuild.mjs';
import { MIN_FILL, MAX_FILL } from './lib/tightfit.mjs';
import { sheetsFromPrepared } from './lib/contactsheet.mjs';
import { inferPackName } from './lib/runrecords.mjs';
import { linkNote } from './lib/publish.mjs';
import { ingestFolder, MAX_CANDIDATES } from './lib/ingest.mjs';
import { discoverRenderers, decodeImageWithBrowser } from './lib/renderers.mjs';
import { resolveRunFolder, listCandidates } from './lib/runfolder.mjs';

const USAGE = `pack.mjs — take a folder of pictures in, build icon packs and contact sheets in a run folder

Usage:
  node scripts/pack.mjs ingest --from <folder of pictures> --run <run folder> [--max <1-64>]
  node scripts/pack.mjs build --run <run folder> [--name <name>] [--title <text>] [--variant <label>] [--only <numbers>] [--fill <50-100>] [--no-crop] [--keep-tile] [--no-sharpen] [--no-edge-clean] [--tolerance <0-120>] [--force]
  node scripts/pack.mjs sheet --run <run folder> [--variant <label>] [--only <numbers>] [--fill <50-100>] [--no-crop] [--keep-tile] [--no-sharpen] [--no-edge-clean] [--tolerance <0-120>] [--force]

ingest takes the pictures of a folder in as candidate-<k>.png files of the run folder (created when
       missing; an existing one must be empty or a run folder made by ingest): PNG, JPEG and GIF (first
       frame) are read built in, WebP and BMP through a headless browser when one is installed. Only the
       files directly inside the folder are opened (not its subfolders, links, hidden or system files),
       in natural name order (img2 before img10); of a file that is not a picture only the first 4 KB
       are read. At most --max new candidates per call (default and limit ${MAX_CANDIDATES}); the pictures
       themselves are never changed, moved or deleted. A picture already in the run (the same bytes) is
       skipped, so running ingest again adds only the new pictures, numbered after the others. A picture
       larger than 1024 px is stored shrunk to 1024 px on its longer side. Prints JSON: the candidates
       added, every file skipped with why (each list shows at most 50 entries; "counts" has the totals).
build  writes pack-<k>/ for every candidate-<k>.png in the run folder (only the
       numbers named by --only, such as 5-12 or 1,3,5-8, when a run was continued
       and just the new candidates need packs): the
       Windows .ico, macOS .icns (the slices a master of 256 px or more is big
       enough for), the Linux hicolor tree,
       web favicons and the master PNG. Sizes above the master are omitted and
       listed, never upscaled.
       Each candidate is first cropped to its subject, which then fills --fill
       percent of the square's longer side (default 96), so the picture stays
       readable at 32 and 16 px. The crop enlarges the picture's pixels a little
       (the warnings say so when it is a lot). --no-crop keeps the original
       margins; --no-sharpen leaves the 16..48 px renderings as the plain shrink
       (by default they get a light sharpening, so eyes and edges stay crisp);
       --no-edge-clean keeps the pale rim the cut-out can leave outside a dark
       outline (by default it is cleaned: that rim shows on a dark background);
       --keep-tile keeps an opaque tile as drawn instead of cropping to
       the picture inside it. Prints a short JSON summary (per candidate: its
       pack, master size, warning codes, the SVG estimate) and writes the full
       detail (measured facts, files, sizes left out) to build-<n>.json in the
       run folder.
sheet  writes sheet-<n>.png contact sheets, eight candidates per sheet, each
       candidate shown on a checkerboard and a dark tile with its 64, 32 and
       16 px renderings. With --only the sheet shows just those candidates and is
       written to NEW files numbered after the existing sheets (sheet-2.png, ...):
       the sheets already there are never touched, so a later round of candidates
       gets its own sheet. Without --only the sheets start at sheet-1.png and an
       existing file needs --force.
--name   the file name inside the packs (windows/<name>.ico ...); without it the
         name of the packs already in the run folder is reused, else "app".
--title  the human title in the web manifest and the .desktop entry.
--variant <label>  builds a second version of the same candidates (another --fill,
         --no-crop ...) into pack-<k>-<label>/ and sheet-<label>-<n>.png beside the
         old ones, which stay untouched. The safe way to "rebuild with other settings".`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { command: null, run: null, from: null, max: null, name: null, force: false, tolerance: DEFAULT_TOLERANCE, fill: DEFAULT_FILL, crop: true, tile: 'crop', sharpen: true, edgeClean: true, only: null, onlyText: null, variant: null, title: null };
  const given = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) given.add(arg);
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === 'build' || arg === 'sheet' || arg === 'ingest') {
      if (options.command !== null) throw new Error(`"${arg}" after "${options.command}": pick one command`);
      options.command = arg;
    } else if (arg === '--run') options.run = value();
    else if (arg === '--from') options.from = value();
    else if (arg === '--max') options.max = Number(value());
    else if (arg === '--name') options.name = value();
    else if (arg === '--force') options.force = true;
    else if (arg === '--tolerance') options.tolerance = Number(value());
    else if (arg === '--fill') options.fill = Number(value()) / 100;
    else if (arg === '--no-crop') options.crop = false;
    else if (arg === '--keep-tile') options.tile = 'keep';
    else if (arg === '--no-sharpen') options.sharpen = false;
    else if (arg === '--no-edge-clean') options.edgeClean = false;
    else if (arg === '--variant') options.variant = value();
    else if (arg === '--title') options.title = value();
    else if (arg === '--only') {
      options.onlyText = value();
      options.only = parseOnly(options.onlyText);
    }
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown option "${arg}"`);
  }
  if (options.command === null) throw new Error('pick a command: ingest, build or sheet');
  if (options.run === null) throw new Error('--run <run folder> is required');
  if (options.command === 'ingest') {
    if (options.from === null) throw new Error('ingest needs --from <folder of pictures>');
    const foreign = [...given].filter((name) => !['--run', '--from', '--max'].includes(name));
    if (foreign.length > 0) throw new Error(`ingest takes only --from, --run and --max (not ${foreign.join(', ')})`);
    if (options.max === null) options.max = MAX_CANDIDATES;
    if (!Number.isInteger(options.max) || options.max < 1 || options.max > MAX_CANDIDATES) {
      throw new Error(`--max must be a whole number from 1 to ${MAX_CANDIDATES}`);
    }
    return options;
  }
  if (options.from !== null || options.max !== null) throw new Error('--from and --max belong to ingest');
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 120) {
    throw new Error('--tolerance must be a number from 0 to 120');
  }
  if (options.variant !== null && !/^(?=.*[a-z])[a-z0-9][a-z0-9-]{0,23}$/.test(options.variant)) {
    throw new Error('--variant must be a short label of lowercase letters, digits and "-" (at least one letter), for example fill90');
  }
  if (options.title !== null && (options.title.trim() === '' || options.title.length > 80)) throw new Error('--title must be 1 to 80 characters');
  if (!Number.isFinite(options.fill) || options.fill < MIN_FILL || options.fill > MAX_FILL) {
    throw new Error(`--fill must be a percentage from ${MIN_FILL * 100} to ${MAX_FILL * 100} (default ${DEFAULT_FILL * 100})`);
  }
  return options;
}

/** "5", "1,3" or "5-12" (and mixes of them) -> a Set of candidate numbers. */
function parseOnly(text) {
  const message = `--only must be candidate numbers such as 5, 1,3 or 5-12 (got "${text}")`;
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) throw new Error(message);
  const wanted = new Set();
  for (const part of text.split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    if (to < from || to - from > 999) throw new Error(message);
    for (let k = from; k <= to; k += 1) wanted.add(k);
  }
  return wanted;
}

function prepareOptions(options) {
  return { tolerance: options.tolerance, fill: options.fill, crop: options.crop, tile: options.tile, edgeClean: options.edgeClean };
}

/** The run folder the user typed, resolved like every named path; a followed link is said out loud. */
function resolveRun(typed) {
  const resolved = resolveRunFolder(typed);
  if (resolved.linked) process.stderr.write(`${linkNote('The run folder', resolved)}\n`);
  return resolved.path;
}

function refusedReason(candidate) {
  return `${candidate.file} is ${candidate.refused}; pack input must be a regular file inside the run folder, so it is refused and never opened`;
}

function unsupportedReason(format) {
  return `the candidate is ${format.toUpperCase()}, which this tool cannot decode without extra software; ` +
    'it gets no pack. Convert it to PNG, or take the original picture in with the ingest command.';
}

function undecodableReason(error) {
  return `the PNG cannot be decoded (${error instanceof Error ? error.message : String(error)}); it gets no pack`;
}

/** The first build-<n>.json that does not exist yet: every build keeps its own detail file. */
function nextDetailFile(runFolder) {
  let highest = 0;
  for (const entry of fs.readdirSync(runFolder)) {
    const match = /^build-(\d+)\.json$/.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `build-${highest + 1}.json`;
}

/** The number the next NEW sheet file gets: one after the highest sheet-<n>.png in the run folder. */
function nextSheetNumber(runFolder, variant = null) {
  let highest = 0;
  const pattern = variant === null ? /^sheet-(\d+)\.png$/ : new RegExp(`^sheet-${variant}-(\\d+)\\.png$`);
  for (const entry of fs.readdirSync(runFolder)) {
    const match = pattern.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function refuseOverwrite(target, force) {
  if (fs.existsSync(target) && !force) {
    throw new Error(
      `${target} already exists. Nothing existing is rewritten by default: --only <numbers> adds a new file for later candidates, ` +
        '--variant <label> writes a separate version beside it, --force overwrites on purpose.',
    );
  }
}

function runBuild(options) {
  const runFolder = resolveRun(options.run);
  const everyCandidate = listCandidates(runFolder);
  if (everyCandidate.length === 0) throw new Error(`no candidate-<k>.png files in ${runFolder}`);
  const candidates = options.only === null ? everyCandidate : everyCandidate.filter((candidate) => options.only.has(candidate.index));
  if (candidates.length === 0) throw new Error(`no candidate matches --only ${options.onlyText} in ${runFolder}`);
  const inferred = options.name === null ? inferPackName(runFolder) : null;
  const name = sanitizeName(options.name ?? inferred ?? 'app');
  const packFolder = (index) => `pack-${index}${options.variant === null ? '' : `-${options.variant}`}`;
  // One clear refusal before anything is written: a build never half-overwrites a run folder.
  if (!options.force) {
    const existing = candidates.filter((candidate) => !candidate.refused && candidate.format === 'png' && fs.existsSync(path.join(runFolder, packFolder(candidate.index))));
    if (existing.length > 0) {
      throw new Error(
        `${existing.map((candidate) => `${packFolder(candidate.index)} already exists`).join('; ')}. Nothing was written. ` +
          'For the new candidates of a later round use --only <their numbers>; to rebuild with other settings (for example --fill 90) ' +
          'use --variant <label>, which writes pack-<k>-<label> folders beside the old ones; --force overwrites on purpose.',
      );
    }
  }
  // The summary printed is short (it has to fit a tool's output even for 64 candidates); the detail goes to a file.
  const result = {
    run: runFolder,
    name,
    nameFrom: options.name !== null ? 'the --name option' : inferred !== null ? 'the packs already in this run folder' : 'the default',
    variant: options.variant,
    skipped: [],
    packs: [],
    detail: null,
  };
  const detail = [];
  for (const candidate of candidates) {
    if (candidate.refused) {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: refusedReason(candidate) });
      continue;
    }
    if (candidate.format !== 'png') {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: unsupportedReason(candidate.format) });
      continue;
    }
    // Decode first: a damaged PNG (valid header, broken body) is skipped with its reason and the
    // usable candidates are still packed. Only the decoding is guarded; a failure while writing still aborts.
    let prepared;
    try {
      prepared = prepareCandidate(fs.readFileSync(path.join(runFolder, candidate.file)), prepareOptions(options));
    } catch (error) {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: undecodableReason(error) });
      continue;
    }
    const packDir = path.join(runFolder, packFolder(candidate.index));
    ensureRealDir(packDir);
    const pack = buildPack(prepared, {
      name,
      title: options.title,
      sharpen: options.sharpen,
      publish: (rel, buffer) => {
        const absolute = path.join(packDir, rel);
        ensureRealDir(path.dirname(absolute));
        refuseOverwrite(absolute, options.force);
        publishPackFile(absolute, buffer);
      },
    });
    result.packs.push({
      candidate: candidate.index,
      pack: packFolder(candidate.index),
      master: pack.masterSize,
      warnings: prepared.warnings.map((warning) => warning.code),
      omitted: pack.omitted.length,
      svgFit: prepared.facts.svgFit.level,
    });
    detail.push({
      candidate: candidate.index,
      packDir,
      masterSize: pack.masterSize,
      facts: prepared.facts,
      warnings: prepared.warnings,
      files: pack.files,
      omitted: pack.omitted,
    });
  }
  if (detail.length > 0) {
    result.detail = nextDetailFile(runFolder);
    const record = { run: runFolder, name, variant: options.variant, skipped: result.skipped, packs: detail };
    publishPackFile(path.join(runFolder, result.detail), Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function runSheet(options) {
  const runFolder = resolveRun(options.run);
  const everyCandidate = listCandidates(runFolder);
  if (!everyCandidate.some((candidate) => candidate.format === 'png')) throw new Error(`no candidate-<k>.png files in ${runFolder}`);
  const candidates = options.only === null ? everyCandidate : everyCandidate.filter((candidate) => options.only.has(candidate.index));
  if (candidates.length === 0) throw new Error(`no candidate matches --only ${options.onlyText} in ${runFolder}`);
  const skipped = [];
  const items = [];
  for (const candidate of candidates) {
    if (candidate.refused) {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: refusedReason(candidate) });
      continue;
    }
    if (candidate.format !== 'png') {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: unsupportedReason(candidate.format) });
      continue;
    }
    try {
      // The sheet labels a candidate with its OWN number (the k of candidate-k), skipped files included.
      items.push({ number: candidate.index, prepared: prepareCandidate(fs.readFileSync(path.join(runFolder, candidate.file)), prepareOptions(options)) });
    } catch (error) {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: undecodableReason(error) });
    }
  }
  if (items.length === 0) {
    throw new Error(`none of the candidate files in ${runFolder} can be used: ${skipped.map((entry) => entry.file).join(', ')}`);
  }
  // With --only the pages are new files after the existing sheets; without it they start at sheet-1.png.
  const sheets = sheetsFromPrepared(items, { firstSheet: options.only === null ? 1 : nextSheetNumber(runFolder, options.variant), sharpen: options.sharpen, series: options.variant });
  const result = { run: runFolder, skipped, sheets: [] };
  for (const sheet of sheets) {
    const target = path.join(runFolder, sheet.file);
    refuseOverwrite(target, options.force);
    publishPackFile(target, sheet.png);
    result.sheets.push({ file: sheet.file, bytes: sheet.png.length, candidates: sheet.count });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/** Take a folder of pictures in. A browser is looked for only when a picture needs one (WebP, BMP, an unusual JPEG). */
async function runIngest(options) {
  let renderer;
  let base = null;
  const browserDecode = async ({ imagePath, bytes, format, width, height }) => {
    if (renderer === undefined) {
      const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
      const browser = discovery.candidates.find((candidate) => candidate.kind === 'browser' && candidate.found);
      renderer = browser ? { name: browser.name, label: browser.label, kind: browser.kind, ...browser.found } : null;
    }
    if (renderer === null) throw new Error('reading it needs a headless browser (Chrome, Chromium or Edge), and none was found');
    base ??= fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-ingest-'));
    return decodeImageWithBrowser({ imagePath, bytes, format, width, height, renderer, tempDir: base });
  };
  try {
    const onNote = (line) => process.stderr.write(`${line}\n`);
    const result = await ingestFolder({ from: options.from, run: options.run, max: options.max, browserDecode, onNote });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.added.length === 0) {
      const { already, skipped } = result.counts;
      const unusable = skipped > 0 ? ` (${skipped} file${skipped === 1 ? ' is' : 's are'} not a usable picture: see "skipped")` : '';
      fail(already > 0
        ? `nothing new to take in: ${already} picture${already === 1 ? ' of that folder is' : 's of that folder are'} already in this run${unusable}`
        : 'no picture could be taken in (the reasons are listed under "skipped")');
    }
  } finally {
    // A browser that was just stopped can hold its profile files for a few seconds.
    if (base !== null) {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
      } catch {
        // best effort: only scratch data in the OS temp folder
      }
    }
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'ingest') await runIngest(options);
  else if (options.command === 'build') runBuild(options);
  else runSheet(options);
} catch (error) {
  fail(error.message);
}
