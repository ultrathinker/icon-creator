// Taking a folder of pictures in: every picture the user already has (from a designer, a design tool, earlier
// attempts...) becomes a numbered candidate (candidate-<k>.png) in a run folder, so pack.mjs can build a finished pack
// for each one and draw contact sheets that show them side by side at 64, 32 and 16 px.
//
// The pictures are only read: never moved, changed or deleted. Only the folder's own files are opened (not its
// subfolders, links, hidden or system files), in natural file-name order (img2 before img10), and of a file that is not
// a picture only its first 4 KB are read (an SVG whose <svg root comes later is reported as not a picture). A picture
// that is already in the run (the same bytes, by SHA-256) is skipped, so taking the same folder in again after new
// pictures were added adds just the new ones, numbered after the candidates that are there. The run records keep, for
// each candidate, the file it came from.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from './png.mjs';
import { loadSource, detectFormat, SUPPORTED_FORMATS } from './imagefile.mjs';
import { decodeSource } from './importimg.mjs';
import { resizeArea } from './pixels.mjs';
import { readRunRecords, PLUGIN_ID } from './runrecords.mjs';
import { ensureRealDir, publishPackFile } from './packbuild.mjs';
import { resolveNamedPath, linkNote } from './publish.mjs';

/** At most this many new candidates per call: eight contact sheets of eight. Run again for the rest. */
export const MAX_CANDIDATES = 64;
/** The longest side a candidate is stored at; a larger picture is shrunk (an icon master is at most 1024 px). */
export const CANDIDATE_MAX_SIDE = 1024;
/** A smaller picture makes no useful icon master. */
export const MIN_CANDIDATE_SIDE = 64;
/** Each list in the result and the records shows at most this many entries; `counts` has the totals. */
export const LIST_LIMIT = 50;

const SNIFF_BYTES = 4096;
const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const CANDIDATE_FILE = /^candidate-(\d+)\.png$/i;
const LISTS = ['skipped', 'already', 'notTaken', 'ignored', 'subfolders'];

/** Natural order: "icon2.png" before "icon10.png"; ties broken by the exact name so the order never depends on the platform. */
export function naturalOrder(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The folder the pictures are in, resolved to its real location (a followed link is noted): it must be a directory. */
function pictureFolder(typed, onNote) {
  const resolved = resolveNamedPath(typed, { reading: true });
  if (resolved.linked) onNote(linkNote('The picture folder', resolved));
  let stat;
  try {
    stat = fs.statSync(resolved.path, { bigint: true });
  } catch {
    throw new Error(`the folder ${resolved.path} does not exist`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${resolved.path} is not a folder: name the folder that holds the pictures (for a single picture use icons.mjs import)`);
  }
  return { folder: resolved.path, stat };
}

/**
 * The run folder, resolved (a followed link is noted) but not created yet: it is created only when there is something to
 * put in it. An existing one must be a real directory that is empty or a run folder of this plugin, so candidates never
 * land among unrelated files, and it must not be the picture folder itself. A folder that holds nothing but
 * candidate-<k>.png files is a run whose record was never written (an ingest that stopped half way): it is continued.
 * Returns { runDir, records } (records null for a new run).
 */
function inspectRunFolder(typed, pictures, onNote) {
  const resolved = resolveNamedPath(typed);
  if (resolved.linked) onNote(linkNote('The run folder', resolved));
  const runDir = resolved.path;
  let stat = null;
  try {
    stat = fs.statSync(runDir, { bigint: true });
  } catch {
    stat = null;
  }
  if (stat === null) return { runDir, records: null };
  if (!stat.isDirectory()) throw new Error(`${runDir} exists and is not a folder`);
  if (stat.dev === pictures.stat.dev && stat.ino === pictures.stat.ino) {
    throw new Error('the run folder must not be the folder of the pictures: name a new folder for the candidates and packs');
  }
  const entries = fs.readdirSync(runDir);
  if (!entries.includes('run.json')) {
    if (entries.length === 0) return { runDir, records: null };
    if (entries.every((entry) => CANDIDATE_FILE.test(entry))) {
      const highest = Math.max(...entries.map((entry) => Number(CANDIDATE_FILE.exec(entry)[1])));
      const problem = `${runDir} holds candidate files but no run.json (an earlier ingest stopped half way): they are kept, new candidates ` +
        'are numbered after them, and the pictures they came from are not known, so those can come in again';
      return { runDir, records: { run: { batches: [], candidates: [] }, nextIndex: highest + 1, nextBatch: 1, problems: [problem], unrecorded: true } };
    }
    throw new Error(
      `${runDir} is not empty and is not a run folder made by this plugin: name a new or empty folder, or a run folder made by ingest`,
    );
  }
  const records = readRunRecords(runDir, { strict: false });
  if (records.run === null) throw new Error(`${runDir} cannot be used: ${records.problems.join('; ')}`);
  return { runDir, records };
}

/** The candidate number already taken by each picture's bytes, from the run records. */
function knownPictures(records) {
  const known = new Map();
  if (records === null) return known;
  for (const candidate of records.run.candidates) {
    if (typeof candidate.sha256 === 'string' && Number.isInteger(candidate.index)) known.set(candidate.sha256, candidate.index);
  }
  return known;
}

/** One past the highest batch-<n>.json in the folder, damaged ones included, so a new record never collides with one. */
function nextBatchFile(runDir, fromRecords) {
  let highest = 0;
  for (const entry of fs.readdirSync(runDir)) {
    const match = /^batch-(\d+)\.json$/i.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return Math.max(fromRecords, highest + 1);
}

/** The first bytes of a file: enough to tell a picture or an SVG from anything else without reading the whole file. */
function sniff(absolute) {
  const fd = fs.openSync(absolute, 'r');
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    return head.subarray(0, fs.readSync(fd, head, 0, SNIFF_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a file whose first bytes are not a raster picture is skipped: an SVG drawing, or not a picture at all. */
function notRasterReason(head, format) {
  if (format === 'svg' && /<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/i.test(head.toString('utf8'))) {
    return 'an SVG is already a drawing: make its icon set with icons.mjs import and export instead';
  }
  return `the file is not a supported image: its content is not ${SUPPORTED_FORMATS} (the file extension is ignored)`;
}

/** Shrink so the longer side is at most `maxSide`, keeping the proportions; a smaller picture is kept as it is. */
function shrinkToFit(decoded, maxSide) {
  const longer = Math.max(decoded.width, decoded.height);
  if (longer <= maxSide) return { width: decoded.width, height: decoded.height, rgba: decoded.rgba };
  const scale = maxSide / longer;
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  return { width, height, rgba: resizeArea(decoded.rgba, decoded.width, decoded.height, width, height) };
}

/** The reason a picture could not be read, without the absolute path the low-level message starts with. */
function shortReason(message, absolute) {
  return message.split(absolute).join('the file').trim();
}

/** Totals in `counts` (taken once), and every list cut to LIST_LIMIT entries, so a folder of thousands of files stays readable. */
function finish(result) {
  if (result.counts === null) {
    result.counts = { added: result.added.length };
    for (const list of LISTS) result.counts[list] = result[list].length;
  }
  for (const list of LISTS) result[list] = result[list].slice(0, LIST_LIMIT);
  return result;
}

/**
 * Take the pictures of folder `from` into run folder `run` as candidate-<k>.png. `browserDecode` (optional) decodes
 * WebP, BMP and the rare JPEG or PNG the built-in decoders cannot read; without it those are skipped with the reason.
 * `onNote` receives the Note: line for a path that went through a link. Every picture is decoded before anything is
 * written; then the candidates are written, then the record (run.json for a new run, batch-<n>.json when a run is
 * continued). Nothing is created when no picture can be taken in. At most `max` new candidates are added: the pictures
 * after them are listed under `notTaken` for the next call. If a write fails half way, the candidates written so far are
 * recorded before the error is raised, so the folder stays a run that the next call continues. `publish` writes one file
 * (tests replace it to make a write fail).
 */
export async function ingestFolder({ from, run, max = MAX_CANDIDATES, browserDecode = null, onNote = () => {}, publish = publishPackFile, now = new Date() }) {
  if (!Number.isInteger(max) || max < 1 || max > MAX_CANDIDATES) {
    throw new Error(`--max must be a whole number from 1 to ${MAX_CANDIDATES}`);
  }
  const pictures = pictureFolder(from, onNote);
  const { runDir, records } = inspectRunFolder(run, pictures, onNote);
  const known = knownPictures(records);
  const result = {
    run: runDir,
    from: pictures.folder,
    batch: null,
    counts: null,
    added: [],
    skipped: [],
    already: [],
    notTaken: [],
    ignored: [],
    subfolders: [],
    ...(records !== null && records.problems.length > 0 ? { recordProblems: records.problems } : {}),
  };

  const ready = [];
  const seenNow = new Map();
  for (const name of fs.readdirSync(pictures.folder).sort(naturalOrder)) {
    const absolute = path.join(pictures.folder, name);
    if (SYSTEM_FILES.has(name.toLowerCase()) || name.startsWith('.')) {
      result.ignored.push(name);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      result.skipped.push({ file: name, reason: `cannot be read (${error.code ?? error.message})` });
      continue;
    }
    if (stat.isSymbolicLink()) {
      result.skipped.push({ file: name, reason: 'a symbolic link or junction: not followed' });
      continue;
    }
    if (stat.isDirectory()) {
      result.subfolders.push(name);
      continue;
    }
    if (!stat.isFile()) {
      result.skipped.push({ file: name, reason: 'not a regular file' });
      continue;
    }
    // The first bytes decide; a file that is not a raster picture is never read further.
    let format;
    try {
      const head = sniff(absolute);
      format = detectFormat(head);
      if (format === null || format === 'svg') {
        result.skipped.push({ file: name, reason: notRasterReason(head, format) });
        continue;
      }
    } catch (error) {
      result.skipped.push({ file: name, reason: `cannot be read (${error.code ?? error.message})` });
      continue;
    }
    let source;
    try {
      source = loadSource(absolute);
    } catch (error) {
      result.skipped.push({ file: name, reason: shortReason(error.message, absolute) });
      continue;
    }
    if (Math.max(source.width, source.height) < MIN_CANDIDATE_SIDE) {
      result.skipped.push({ file: name, reason: `${source.width}x${source.height} px is too small for an icon master (at least ${MIN_CANDIDATE_SIDE} px on the longer side)` });
      continue;
    }
    const hash = sha256(source.buffer);
    if (known.has(hash)) {
      result.already.push({ file: name, candidate: known.get(hash) });
      continue;
    }
    if (seenNow.has(hash)) {
      result.skipped.push({ file: name, reason: `the same picture as ${seenNow.get(hash)}` });
      continue;
    }
    seenNow.set(hash, name);
    if (ready.length >= max) {
      result.notTaken.push(name);
      continue;
    }
    // Every picture is decoded before anything is written (one that cannot be decoded is skipped, never half-written);
    // only its stored copy of at most 1024 px is kept, so 64 large pictures do not pile up in memory.
    try {
      const decoded = await decodeSource(source, { browserDecode });
      ready.push({
        name,
        hash,
        format: source.format,
        width: source.width,
        height: source.height,
        via: decoded.via,
        frames: decoded.frames,
        fitted: shrinkToFit(decoded, CANDIDATE_MAX_SIDE),
      });
    } catch (error) {
      result.skipped.push({ file: name, reason: shortReason(error.message, source.path) });
    }
  }
  if (ready.length === 0) return finish(result);

  ensureRealDir(runDir);
  const firstRecord = records === null || records.unrecorded === true;
  const first = records === null ? 1 : records.nextIndex;
  const batchNumber = firstRecord ? 1 : nextBatchFile(runDir, records.nextBatch);
  const recordFile = path.join(runDir, firstRecord ? 'run.json' : `batch-${batchNumber}.json`);
  const targets = ready.map((item, offset) => path.join(runDir, `candidate-${first + offset}.png`));
  // A run that changed while the pictures were read: refuse before the first write.
  const taken = [...targets, recordFile].filter((target) => fs.existsSync(target));
  if (taken.length > 0) {
    throw new Error(`${taken.join(', ')} appeared while the pictures were read; nothing was written, run ingest again`);
  }

  const created = now.toISOString();
  const candidates = [];
  let failure = null;
  for (const [offset, item] of ready.entries()) {
    const index = first + offset;
    try {
      publish(targets[offset], encodePng(item.fitted.width, item.fitted.height, item.fitted.rgba));
    } catch (error) {
      failure = error;
      break;
    }
    candidates.push({ index, batch: batchNumber, file: `candidate-${index}.png`, source: item.name, sha256: item.hash, format: item.format, width: item.width, height: item.height });
    result.added.push({
      candidate: index,
      file: `candidate-${index}.png`,
      source: item.name,
      format: item.format,
      size: `${item.width}x${item.height}`,
      stored: `${item.fitted.width}x${item.fitted.height}`,
      decodedBy: item.via,
      ...(item.frames > 1 ? { note: 'animated GIF: only the first frame is used' } : {}),
    });
  }
  if (candidates.length > 0) {
    finish(result);
    const batch = {
      number: batchNumber,
      created,
      source: 'folder',
      folder: pictures.folder,
      candidates: candidates.map((candidate) => candidate.index),
      skipped: result.skipped,
      skippedCount: result.counts.skipped,
      notTaken: result.counts.notTaken,
    };
    const record = firstRecord ? { created, plugin: PLUGIN_ID, batches: [batch], candidates } : { plugin: PLUGIN_ID, batch, candidates };
    publish(recordFile, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
    result.batch = batchNumber;
  }
  if (failure !== null) {
    const kept = candidates.length === 0 ? 'nothing was written' : `candidates ${first} to ${first + candidates.length - 1} were written and recorded`;
    throw new Error(`writing ${path.basename(targets[candidates.length])} failed (${failure.message}); ${kept}. Run ingest again for the rest.`);
  }
  return finish(result);
}
