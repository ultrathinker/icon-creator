// What both command-line tools need to find things in a run folder: the folder itself and its candidate-<k> files. Moved
// out of pack.mjs so svg.mjs uses the very same checks.

import fs from 'node:fs';
import path from 'node:path';
import { detectFormat } from './imagefile.mjs';
import { resolveNamedPath } from './publish.mjs';

/**
 * The run folder the user typed, resolved by the rule of every named path (publish.mjs): a link outside the current
 * folder (macOS /tmp, a linked folder, a Windows junction) is followed once, a link inside the current folder is refused
 * with the real path to pass instead (`reading` words that refusal for a command that only reads). The folder must exist.
 * Returns { path, linked, typed }: when `linked`, the caller
 * says so with linkNote. Below the run folder no link is ever followed (listCandidates and the writers refuse them).
 */
export function resolveRunFolder(typed, { reading = false } = {}) {
  const resolved = resolveNamedPath(typed, { reading });
  let stat;
  try {
    stat = fs.statSync(resolved.path);
  } catch {
    throw new Error(`the run folder ${resolved.path} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`${resolved.path} exists and is not a directory`);
  return resolved;
}

/** candidate-<k>.<ext> files in index order, split into PNG and other formats. */
export function listCandidates(runFolder) {
  const entries = fs.readdirSync(runFolder);
  const found = [];
  for (const entry of entries) {
    const match = /^candidate-(\d+)\.(png|jpg|jpeg|webp)$/i.exec(entry);
    if (match === null) continue;
    // lstat BEFORE any read: a candidate that is a symbolic link, a junction or not a regular file would make the
    // pack read something outside the run folder, so it is refused (reported under `skipped`), never opened.
    const stat = fs.lstatSync(path.join(runFolder, entry));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      found.push({ file: entry, index: Number(match[1]), format: match[2].toLowerCase(), refused: stat.isSymbolicLink() ? 'a symbolic link or junction' : 'not a regular file' });
      continue;
    }
    found.push({ file: entry, index: Number(match[1]), format: detectFormat(fs.readFileSync(path.join(runFolder, entry))) ?? match[2].toLowerCase() });
  }
  found.sort((a, b) => a.index - b.index || a.file.localeCompare(b.file));
  const seen = new Set();
  for (const item of found) {
    if (seen.has(item.index)) throw new Error(`two candidates numbered ${item.index} in ${runFolder}`);
    seen.add(item.index);
  }
  return found;
}
