// Safe publication of output files: no output may be redirected outside the
// path the user named through a symbolic link, a junction or a hardlink.
//
// Two rules, applied by every write path in this tool:
//  - the parent chain of the output must consist of real directories (a
//    symlinked parent would redirect the write somewhere else entirely);
//  - the staged file used for the final rename is created EXCLUSIVELY
//    ('wx': fail if the entry already exists), so a planted alias at the
//    staging name can never be written through, and the rename then replaces
//    the target's directory entry instead of following it.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Refuse when any component of `filePath`'s containing directory chain (from
 * the filesystem root down to the parent directory) is a symbolic link or
 * junction, or when the parent directory does not exist. The file entry
 * itself is not examined here - callers inspect the leaf separately.
 */
export function assertRealParentChain(filePath) {
  const absolute = path.resolve(filePath);
  const { root } = path.parse(absolute);
  const directory = path.dirname(absolute);
  const segments = directory.slice(root.length).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat === null) {
      throw new Error(`the output directory ${current} does not exist; create it first`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${current} is a symbolic link or junction: refusing to write through it - pass the real path instead`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`${current} exists and is not a directory`);
    }
  }
}

/**
 * Refuse when any EXISTING ancestor of `dir` (dir itself excluded - it is
 * the thing the user explicitly named and may legitimately be a link) is a
 * symbolic link, junction or non-directory. Missing ancestors are fine: they
 * will be created fresh below the last real directory. This guards paths
 * like `--out <symlinked-parent>/new-folder`, where creating the output
 * folder recursively would otherwise follow the link out of the named path.
 */
export function assertRealAncestors(dir) {
  const absolute = path.resolve(dir);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    // A missing ancestor means nothing exists below it either, so there is
    // no link left to follow; the fresh directories are created real.
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${current} is a symbolic link or junction: refusing to create output folders through it - pass the real path instead`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`${current} exists and is not a directory`);
    }
  }
}

/**
 * Publish `buffer` at `targetPath`: stage into a freshly, exclusively created
 * sibling file, then rename it over the target (replacing the directory
 * entry, never writing through what was there). `stagedPath` can override the
 * staging entry's name; it is still created with 'wx', so a pre-existing or
 * planted entry at that name is refused rather than followed.
 */
export function publishExclusive(targetPath, buffer, { stagedPath = null } = {}) {
  const staged =
    stagedPath ??
    `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(staged, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.closeSync(fd);
    fs.renameSync(staged, targetPath);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fs.rmSync(staged, { force: true });
    throw error;
  }
}
