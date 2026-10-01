// Running a headless browser without depending on it to exit.
//
// A headless Chrome started with --screenshot normally writes the file and
// exits within a second, but on a real MacBook it intermittently kept running
// for 40 s or more AFTER the screenshot was complete. Waiting for the process
// to exit then cost a full timeout per render. So the tool waits for the
// RESULT (the caller's `probe`), not for the process, and ends the whole
// browser - the process and every helper it started - as soon as the result is
// there, on timeout, and when this program itself exits or is interrupted.
//
// POSIX: the browser is started in its own process group (detached) and the
// group is signalled, so helper processes die with it. Windows: the tree is
// ended with `taskkill /T /F`.

import { spawn, spawnSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

// Browsers this process has started and not yet ended.
const active = new Set();
let hooksInstalled = false;

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** End a browser process tree synchronously. Used when the program is leaving. */
function killTreeSync(pid) {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    signalGroup(pid, 'SIGKILL');
  }
}

function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => {
    for (const pid of active) killTreeSync(pid);
    active.clear();
  });
  // Ctrl-C, a terminate request or a closed terminal: end the browsers, then
  // let the signal take its default course (the browser is in its own process
  // group on POSIX, so it would otherwise survive this program).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      for (const pid of active) killTreeSync(pid);
      active.clear();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * End the browser the way it was started: the whole group (POSIX: terminate,
 * then kill what is left after a short grace) or the whole tree (Windows).
 * Returns once nothing of it is left or the grace has passed.
 */
async function terminate(child) {
  const pid = child.pid;
  if (!pid) return;
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
    await waitForExit(child, 3000);
  } else {
    signalGroup(pid, 'SIGTERM');
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && groupAlive(pid)) await sleep(50);
    if (groupAlive(pid)) {
      signalGroup(pid, 'SIGKILL');
      const last = Date.now() + 1500;
      while (Date.now() < last && groupAlive(pid)) await sleep(50);
    }
  }
  active.delete(pid);
}

/**
 * Start a browser and wait for its RESULT. `probe({ exited })` is called every
 * `pollMs` while the browser runs and returns null while there is nothing yet,
 * or the final verdict (any non-null value) once the output is complete. The
 * browser is ended in every case before this resolves.
 *
 * Timing: while the process is running the verdict must arrive within
 * `timeoutMs` (resolves { timedOut: true }); if the process exits first the
 * output gets `exitGraceMs` more (a launcher that hands over to a child and
 * exits at once, as chrome.exe does when started from an elevated shell, writes
 * its file a little later).
 *
 * Resolves { verdict, timedOut, error }; `verdict` is null when none arrived.
 */
export async function runBrowser(command, args, { probe, timeoutMs = 45000, exitGraceMs = 20000, pollMs = 150 } = {}) {
  installExitHooks();
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: !IS_WINDOWS });
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error.message;
  });
  if (child.pid) active.add(child.pid);
  let exitedAt = null;
  child.on('exit', () => {
    exitedAt = Date.now();
  });
  const deadline = Date.now() + timeoutMs;
  let verdict = null;
  let timedOut = false;
  try {
    for (;;) {
      if (spawnError !== null) break;
      verdict = await probe({ exited: exitedAt !== null });
      if (verdict !== null) break;
      if (exitedAt !== null) {
        if (Date.now() - exitedAt > exitGraceMs) break;
      } else if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await sleep(pollMs);
    }
  } finally {
    await terminate(child);
  }
  return { verdict, timedOut, error: spawnError };
}
