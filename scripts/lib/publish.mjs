// Safe publication of output files: no output may be redirected outside the
// path the user named through a symbolic link, a junction or a hardlink.
//
// Rules, applied by every write path in this tool:
//  - a path the user names is resolved once to its real location (links in it
//    are the user's own choice or the operating system's, such as macOS
//    /var -> /private/var), but a link inside the current folder - the user's
//    project - is refused, as is any link below an output folder (see
//    `resolveNamedPath` and the export's directory walk);
//  - the staged file used for the final rename is created EXCLUSIVELY
//    ('wx': fail if the entry already exists), so a planted alias at the
//    staging name can never be written through, and the rename then replaces
//    the target's directory entry instead of following it.

import fs from 'node:fs';
import path from 'node:path';

function isInside(child, parent) {
  const fold = process.platform === 'win32' || process.platform === 'darwin' ? (value) => value.toLowerCase() : (value) => value;
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a path the user NAMED into the real location the tool will use.
 *
 * Two zones, one rule each:
 *  - Outside the current folder the path is a location the user chose, and
 *    links in it are part of that choice: macOS keeps /var, /tmp and /etc as
 *    symbolic links into /private, a project can sit behind a linked folder,
 *    on Windows a folder can be a junction. Each link is followed once and the
 *    result is the real path (`linked` tells the caller to say so out loud).
 *  - Inside the current folder (the user's project) a link is content, not a
 *    choice: a repository can ship `icon-work -> ~/somewhere-else`. A link whose
 *    containing folder is inside the current folder is refused, with the real
 *    path to pass instead. The current folder itself is resolved first, so a
 *    project reached through an OS alias is not mistaken for a planted link.
 *
 * Everything below the first missing component is new and is created as real
 * directories by the caller. Returns { path, linked, typed }.
 */
export function resolveNamedPath(typed, { reading = false } = {}) {
  const absolute = path.resolve(typed);
  let project;
  try {
    project = fs.realpathSync(process.cwd());
  } catch {
    project = path.resolve(process.cwd());
  }
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  let linked = false;
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(current, segments[index]);
    let stat = null;
    try {
      stat = fs.lstatSync(next);
    } catch {
      stat = null;
    }
    if (stat === null) {
      current = path.join(current, ...segments.slice(index));
      break;
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = fs.realpathSync(next);
      } catch (error) {
        throw new Error(`${next} is a symbolic link or junction that cannot be resolved (${error.code}); pass the real path instead`);
      }
      if (isInside(current, project)) {
        throw new Error(
          `${next} is a symbolic link or junction inside the current folder (${project}): refusing to ${reading ? 'read' : 'write'} through it - ` +
            `it points to ${target}; pass that real path instead`,
        );
      }
      linked = true;
      current = target;
    } else {
      current = next;
    }
  }
  return { path: current, linked, typed: absolute };
}

/** The sentence the CLI prints when a link in a named path was followed. */
export function linkNote(label, resolved) {
  return `Note: ${label} ${resolved.typed} goes through a symbolic link or junction; using its real location ${resolved.path}.`;
}

/**
 * Resolve a file the user NAMED AS AN INPUT (an SVG to render or export, a
 * small variant): its directories follow the same rule as any named path
 * (an outside link is followed once and reported, a link inside the current
 * folder is refused), and the file itself must not be a link - a link planted
 * in a repository could otherwise make the tool read some other file than the
 * one named. A missing file is returned as is; reading it reports the usual
 * "no such file". Returns { path, linked, typed }.
 */
export function resolveInputFile(filePath) {
  const typed = path.resolve(filePath);
  const directory = resolveNamedPath(path.dirname(typed), { reading: true });
  const resolved = path.join(directory.path, path.basename(typed));
  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    stat = null;
  }
  if (stat !== null && stat.isSymbolicLink()) {
    let target = 'somewhere else';
    try {
      target = fs.realpathSync(resolved);
    } catch {
      // a dangling link: say so below
    }
    throw new Error(`${resolved} is a symbolic link: refusing to follow it - it points to ${target}; pass that real path instead`);
  }
  return { path: resolved, linked: directory.linked, typed };
}

/**
 * Resolve the file an output will be written to: the directory part is
 * resolved with `resolveNamedPath` and must exist and be a directory; the file
 * entry itself is not examined here - callers inspect the leaf separately.
 * Returns { path, linked, typed }.
 */
export function resolveOutputFile(filePath) {
  const absolute = path.resolve(filePath);
  const directory = resolveNamedPath(path.dirname(absolute));
  let stat = null;
  try {
    stat = fs.statSync(directory.path);
  } catch {
    stat = null;
  }
  if (stat === null) {
    throw new Error(`the output directory ${directory.path} does not exist; create it first`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${directory.path} exists and is not a directory`);
  }
  return { path: path.join(directory.path, path.basename(absolute)), linked: directory.linked, typed: absolute };
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
