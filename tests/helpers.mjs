import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Remove a temp tree, tolerating a Chromium crashpad handler that is still
 * releasing profile files. Best effort: the directory sits in the OS temp
 * dir, so a rare leftover is harmless and must never fail a test run.
 */
export function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch {
    // ignored on purpose: see the doc comment
  }
}

/**
 * Create a directory link: a junction on Windows (needs no privilege), a
 * symbolic link elsewhere. Links to directories are what the planted-link and
 * operating-system-alias cases are made of.
 */
export function makeDirLink(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** A skip reason when this user cannot create directory links, else undefined. */
export const dirLinkSkipReason = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-linkprobe-'));
    fs.mkdirSync(path.join(probe, 'target'));
    makeDirLink(path.join(probe, 'target'), path.join(probe, 'link'));
    removeTree(probe);
    return undefined;
  } catch {
    return 'this user cannot create directory links here';
  }
})();

/**
 * Run `body` with the process working directory set to `dir` (the folder the
 * tool treats as the user's project), restoring it afterwards. Tests inside
 * one file run one after another, so this cannot leak into a neighbour.
 */
export async function withCwd(dir, body) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(before);
  }
}

/**
 * A temporary folder that is reached through a link, like macOS's /var/folders
 * behind /var -> /private/var. Returns { base, real, linked } where `linked`
 * is the path through the link and `real` the actual folder; both are empty.
 */
export function makeAliasedTemp(prefix = 'icon-creator-alias-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const real = path.join(base, 'real');
  const linked = path.join(base, 'alias');
  fs.mkdirSync(real);
  makeDirLink(real, linked);
  return { base, real, linked };
}
