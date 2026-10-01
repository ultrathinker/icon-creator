import fs from 'node:fs';

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
