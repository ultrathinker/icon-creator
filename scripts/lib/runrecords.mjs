// What a run folder says about itself: run.json (the first round) and one batch-<n>.json per later round, read together.
// Used by ingest, to number new candidates after the others and to skip pictures already taken in. Pure reads, nothing
// is ever written here.

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ID = 'icon-creator';
const RECORD_MAX_BYTES = 4 * 1024 * 1024;

/** The plain objects of a list from a record (a hand-edited or damaged file may hold nulls and numbers); anything else is dropped. */
const objectsOnly = (list) => (Array.isArray(list) ? list.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) : []);

/** run.json with its lists cleaned of anything that is not a plain object. */
function normalizeRun(parsed) {
  return { ...parsed, batches: objectsOnly(parsed.batches), candidates: objectsOnly(parsed.candidates) };
}

function regularFile(absolute) {
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = null;
  }
  return stat !== null && !stat.isSymbolicLink() && stat.isFile() ? stat : null;
}

/**
 * Read run.json and every batch-<n>.json of `runDir` into one view:
 * { run: { created, plugin, batches, candidates }, nextIndex, nextBatch, problems }.
 * `strict` throws an Error on the first problem; otherwise (what ingest, pack.mjs and svg.mjs use) a missing or damaged record
 * is skipped, listed in `problems`, and `run` is null when run.json itself is unusable.
 */
export function readRunRecords(runDir, { strict = true } = {}) {
  const problems = [];
  const bad = (message) => {
    if (strict) throw new Error(message);
    problems.push(message);
    return null;
  };
  const runJson = path.join(runDir, 'run.json');
  const stat = regularFile(runJson);
  if (stat === null) {
    bad(`${runDir} has no run.json of its own: it is not a run folder made by this plugin`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  if (stat.size > RECORD_MAX_BYTES) {
    bad(`${runJson} is too large to be a run.json`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(runJson, 'utf8'));
  } catch {
    bad(`${runJson} is not valid JSON`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.plugin !== PLUGIN_ID || !Array.isArray(parsed.batches)) {
    bad(`${runDir} is not a run folder made by this plugin (run.json does not say so)`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  const run = normalizeRun(parsed);
  // A continued run keeps run.json exactly as it was written and adds a batch-<n>.json per later round.
  const batchFiles = fs.readdirSync(runDir)
    .map((entry) => ({ entry, match: /^batch-(\d+)\.json$/.exec(entry) }))
    .filter(({ match }) => match !== null)
    .map(({ entry, match }) => ({ entry, number: Number(match[1]) }))
    .sort((a, b) => a.number - b.number);
  for (const { entry, number } of batchFiles) {
    const absolute = path.join(runDir, entry);
    const batchStat = regularFile(absolute);
    if (batchStat === null || batchStat.size > RECORD_MAX_BYTES) {
      bad(`${absolute} is not a regular batch file of this plugin`);
      continue;
    }
    let batchParsed;
    try {
      batchParsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
      bad(`${absolute} is not valid JSON`);
      continue;
    }
    if (batchParsed === null || typeof batchParsed !== 'object' || batchParsed.plugin !== PLUGIN_ID ||
        batchParsed.batch === null || typeof batchParsed.batch !== 'object' || batchParsed.batch.number !== number ||
        !Array.isArray(batchParsed.candidates)) {
      bad(`${absolute} is not a batch file made by this plugin`);
      continue;
    }
    run.batches.push(batchParsed.batch);
    run.candidates.push(...objectsOnly(batchParsed.candidates));
  }
  let highest = 0;
  for (const candidate of run.candidates) if (Number.isInteger(candidate.index) && candidate.index > highest) highest = candidate.index;
  for (const entry of fs.readdirSync(runDir)) {
    const match = /^candidate-(\d+)\.[a-z]+$/i.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  const nextBatch = Math.max(0, ...run.batches.map((batch) => (Number.isInteger(batch.number) ? batch.number : 0))) + 1;
  return { run, nextIndex: highest + 1, nextBatch, problems };
}

/**
 * The file name the packs of this run were built with (windows/<name>.ico of the first pack that has one), or null.
 * A later round reuses it, so round 2 does not produce app.ico beside chess-clock.ico.
 */
export function inferPackName(runDir) {
  let entries;
  try {
    entries = fs.readdirSync(runDir).filter((entry) => /^pack-\d+(-[a-z0-9-]+)?$/.test(entry)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const ico = fs.readdirSync(path.join(runDir, entry, 'windows')).find((file) => file.endsWith('.ico'));
      if (ico !== undefined) return ico.slice(0, -4);
    } catch {
      // no windows folder in this pack
    }
  }
  return null;
}
