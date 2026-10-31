// The browser is ended by the tool, never waited for. These tests use a fake
// "browser" (tests/fixtures/fake-browser.mjs) that behaves like the macOS
// failure: it writes a valid screenshot and then keeps running, with a helper
// process of its own. No real browser is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBrowser } from '../scripts/lib/browserproc.mjs';
import { renderSvgPng, decodeImageWithBrowser, CLI_TOOL_BUILDERS } from '../scripts/lib/renderers.mjs';
import { removeTree } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-browser.mjs');
const LEAVER = path.join(here, 'fixtures', 'leave-browser.mjs');
const CLOCK = path.join(here, 'fixtures', 'clock.svg');
const FAKE_TOOL = path.join(here, 'fixtures', 'fake-tool.mjs');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

async function waitUntil(condition, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** Every pid the fake recorded (browser and helper, one line per launch). */
function recordedPids(pidsFile) {
  if (!fs.existsSync(pidsFile)) return [];
  return fs
    .readFileSync(pidsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => line.split(' ').map(Number));
}

async function withFake(mode, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-fake-'));
  const pidsFile = path.join(dir, 'pids.txt');
  const before = { mode: process.env.FAKE_BROWSER_MODE, pids: process.env.FAKE_BROWSER_PIDS };
  process.env.FAKE_BROWSER_MODE = mode;
  process.env.FAKE_BROWSER_PIDS = pidsFile;
  try {
    return await body({ dir, pidsFile });
  } finally {
    for (const [key, value] of [['FAKE_BROWSER_MODE', before.mode], ['FAKE_BROWSER_PIDS', before.pids]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Whatever a failing test left behind must not outlive it.
    for (const pid of recordedPids(pidsFile)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    removeTree(dir);
  }
}

const fakeRenderer = (timing) => ({
  kind: 'browser',
  name: 'fake',
  label: 'Fake browser',
  path: process.execPath,
  prefixArgs: [FAKE],
  ...(timing ? { timing } : {}),
});

test('runBrowser returns as soon as the output is complete, though the browser keeps running, and ends the whole browser', async () => {
  await withFake('linger', async ({ dir, pidsFile }) => {
    const out = path.join(dir, 'shot.png');
    const started = Date.now();
    const result = await runBrowser(process.execPath, [FAKE, `--screenshot=${out}`, '--window-size=16,16'], {
      probe: async () => (fs.existsSync(out) && fs.statSync(out).size > 0 ? { ok: true } : null),
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(result.verdict, { ok: true });
    assert.equal(result.timedOut, false);
    assert.ok(elapsed < 10000, `waited ${elapsed} ms for a browser that never exits`);
    const pids = recordedPids(pidsFile);
    assert.equal(pids.length, 2, 'the fake records its own pid and its helper pid');
    for (const pid of pids) assert.equal(alive(pid), false, `process ${pid} was left running`);
  });
});

test('runBrowser gives up after the total timeout when nothing is ever written, and ends the browser', async () => {
  await withFake('silent', async ({ dir, pidsFile }) => {
    const started = Date.now();
    const result = await runBrowser(process.execPath, [FAKE, `--screenshot=${path.join(dir, 'never.png')}`], {
      probe: async () => null,
      timeoutMs: 1200,
    });
    assert.equal(result.verdict, null);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 10000);
    const pids = recordedPids(pidsFile);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.equal(alive(pid), false, `process ${pid} was left running`);
  });
});

test('runBrowser reports a browser that cannot be started', async () => {
  const result = await runBrowser(path.join(os.tmpdir(), 'icon-creator-no-such-browser'), [], {
    probe: async () => null,
    timeoutMs: 5000,
  });
  assert.equal(result.verdict, null);
  assert.match(result.error, /ENOENT|not found|spawn/i);
});

test('the exit hook ends a browser that is still running when the program leaves', async () => {
  await withFake('linger', async ({ dir, pidsFile }) => {
    const child = spawn(process.execPath, [LEAVER, FAKE, path.join(dir, 'never.png')], { stdio: 'ignore', env: process.env });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    const pids = recordedPids(pidsFile);
    assert.equal(pids.length, 2, 'the fake must have started before the program left');
    for (const pid of pids) {
      assert.ok(await waitUntil(() => !alive(pid), 5000), `process ${pid} outlived the program that started it`);
    }
  });
});

test('renderSvgPng finishes quickly with a browser that lingers after the screenshot, and leaves nothing running', async () => {
  await withFake('linger', async ({ dir, pidsFile }) => {
    const out = path.join(dir, 'clock-32.png');
    const started = Date.now();
    const verified = await renderSvgPng({ svgPath: CLOCK, size: 32, outPath: out, renderer: fakeRenderer(), tempDir: dir });
    assert.ok(Date.now() - started < 10000, 'the render waited for the browser to exit');
    assert.equal(verified.width, 32);
    assert.ok(fs.statSync(out).size > 0);
    for (const pid of recordedPids(pidsFile)) assert.equal(alive(pid), false, `process ${pid} was left running`);
  });
});

test('renderSvgPng does not accept a half-written screenshot', async () => {
  await withFake('partial', async ({ dir }) => {
    const out = path.join(dir, 'clock-48.png');
    const verified = await renderSvgPng({ svgPath: CLOCK, size: 48, outPath: out, renderer: fakeRenderer(), tempDir: dir });
    assert.equal(verified.width, 48);
    assert.equal(verified.height, 48);
  });
});

test('renderSvgPng retries on a fresh profile when the first browser writes nothing, then succeeds', async () => {
  await withFake('silent-once', async ({ dir, pidsFile }) => {
    const out = path.join(dir, 'clock-24.png');
    const notes = [];
    await renderSvgPng({
      svgPath: CLOCK,
      size: 24,
      outPath: out,
      renderer: fakeRenderer({ timeoutMs: 1200 }),
      tempDir: dir,
      log: (line) => notes.push(line),
    });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /retrying with a fresh profile/);
    assert.equal(recordedPids(pidsFile).length, 4, 'two launches, a browser and a helper each');
    for (const pid of recordedPids(pidsFile)) assert.equal(alive(pid), false, `process ${pid} was left running`);
  });
});

test('renderSvgPng fails with a clear message when the browser never writes anything, and still ends it', async () => {
  await withFake('silent', async ({ dir, pidsFile }) => {
    const out = path.join(dir, 'clock-16.png');
    const started = Date.now();
    await assert.rejects(
      renderSvgPng({ svgPath: CLOCK, size: 16, outPath: out, renderer: fakeRenderer({ timeoutMs: 800 }), tempDir: dir }),
      /Fake browser could not render 16x16px: wrote no screenshot/,
    );
    assert.ok(Date.now() - started < 15000);
    assert.equal(fs.existsSync(out), false);
    assert.equal(recordedPids(pidsFile).length, 4, 'one launch and one retry');
    for (const pid of recordedPids(pidsFile)) assert.equal(alive(pid), false, `process ${pid} was left running`);
  });
});

// ---- the renderer is shown the text that was checked, not the path ------------------------------------------------

// The sample SVGs are files: the one that is checked, and a different one that replaces it after the check.
const CHECKED_SVG = fs.readFileSync(path.join(here, 'fixtures', 'checked.svg'), 'utf8');
const SWAPPED_SVG = fs.readFileSync(path.join(here, 'fixtures', 'swapped.svg'), 'utf8');

async function withEnv(values, body) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const seenBy = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test('renderSvgPng shows the browser a private copy of the text it checked: a file swapped after the check is not drawn', async () => {
  await withFake('exit', async ({ dir }) => {
    const user = path.join(dir, 'icon.svg');
    const seen = path.join(dir, 'seen.jsonl');
    fs.writeFileSync(user, CHECKED_SVG);
    await withEnv({ FAKE_BROWSER_SEEN: seen, FAKE_BROWSER_SWAP: user, FAKE_BROWSER_SWAP_TEXT: SWAPPED_SVG }, () =>
      renderSvgPng({ svgPath: user, size: 16, outPath: path.join(dir, 'icon-16.png'), renderer: fakeRenderer(), tempDir: dir }),
    );
    const [record] = seenBy(seen);
    assert.equal(fs.readFileSync(user, 'utf8'), SWAPPED_SVG, 'the swap did happen, after the check and before the render');
    assert.equal(record.text, CHECKED_SVG, 'the browser was shown the checked text');
    assert.notEqual(path.resolve(fileURLToPath(record.src)), path.resolve(user), 'and not the path the user named');
    assert.equal(fs.existsSync(fileURLToPath(record.src)), false, 'the private copy is removed afterwards');
  });
});

test('renderSvgPng shows a command-line renderer a private copy of the text it checked as well', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-faketool-'));
  const original = CLI_TOOL_BUILDERS.resvg;
  CLI_TOOL_BUILDERS.resvg = (svg, size, out) => [FAKE_TOOL, svg, out, String(size)];
  try {
    const user = path.join(dir, 'icon.svg');
    const seen = path.join(dir, 'seen.jsonl');
    fs.writeFileSync(user, CHECKED_SVG);
    const renderer = { kind: 'cli', name: 'resvg', label: 'resvg', path: process.execPath };
    await withEnv({ FAKE_TOOL_SEEN: seen, FAKE_TOOL_SWAP: user, FAKE_TOOL_SWAP_TEXT: SWAPPED_SVG }, () =>
      renderSvgPng({ svgPath: user, size: 16, outPath: path.join(dir, 'icon-16.png'), renderer, tempDir: dir }),
    );
    const [record] = seenBy(seen);
    assert.equal(fs.readFileSync(user, 'utf8'), SWAPPED_SVG, 'the swap did happen, after the check and before the render');
    assert.equal(record.text, CHECKED_SVG, 'the tool was shown the checked text');
    assert.notEqual(path.resolve(record.svgPath), path.resolve(user), 'and not the path the user named');
    assert.equal(fs.existsSync(record.svgPath), false, 'the private copy is removed afterwards');
  } finally {
    CLI_TOOL_BUILDERS.resvg = original;
    removeTree(dir);
  }
});

test('decodeImageWithBrowser shows the browser a private copy of the bytes it was given: a file swapped after the check is not decoded', async () => {
  await withFake('exit', async ({ dir }) => {
    // The name lies: these bytes are a WebP, and a browser would show a file called .svg as an SVG.
    const user = path.join(dir, 'picture.svg');
    const seen = path.join(dir, 'seen.jsonl');
    const checked = Buffer.from('the bytes that were read and checked');
    fs.writeFileSync(user, checked);
    // The fake browser paints no verdict row, so the decode itself is refused; what matters is what it was shown.
    await withEnv({ FAKE_BROWSER_SEEN: seen, FAKE_BROWSER_SWAP: user, FAKE_BROWSER_SWAP_TEXT: SWAPPED_SVG }, () =>
      assert.rejects(
        decodeImageWithBrowser({ imagePath: user, bytes: checked, format: 'webp', width: 16, height: 16, renderer: fakeRenderer(), tempDir: dir }),
        /could not decode picture\.svg/,
      ),
    );
    const [record] = seenBy(seen);
    assert.equal(fs.readFileSync(user, 'utf8'), SWAPPED_SVG, 'the swap did happen, after the check and before the decode');
    assert.equal(record.text, checked.toString('utf8'), 'the browser was shown the bytes that were checked');
    assert.notEqual(path.resolve(fileURLToPath(record.src)), path.resolve(user), 'and not the path the user named');
    assert.match(path.basename(fileURLToPath(record.src)), /\.webp$/, 'the copy is named by the detected format, not by the name the user gave');
    assert.equal(fs.existsSync(fileURLToPath(record.src)), false, 'the private copy is removed afterwards');
  });
});

test('decodeImageWithBrowser gives the private copy no suffix when the format is not known', async () => {
  await withFake('exit', async ({ dir }) => {
    const user = path.join(dir, 'picture.svg');
    const seen = path.join(dir, 'seen.jsonl');
    fs.writeFileSync(user, 'x');
    await withEnv({ FAKE_BROWSER_SEEN: seen }, () =>
      assert.rejects(decodeImageWithBrowser({ imagePath: user, bytes: Buffer.from('x'), width: 16, height: 16, renderer: fakeRenderer(), tempDir: dir }), /could not decode/),
    );
    const [record] = seenBy(seen);
    assert.match(path.basename(fileURLToPath(record.src)), /^decode-src-\d+-\d+$/);
  });
});

test('the private copy is removed even when the first removals are refused for a moment, and nothing else is touched', async () => {
  await withFake('exit', async ({ dir }) => {
    const user = path.join(dir, 'icon.svg');
    fs.writeFileSync(user, CHECKED_SVG);
    const bystander = path.join(dir, 'svg-16-bystander.txt');
    fs.writeFileSync(bystander, 'not ours');
    const realRemove = fs.rmSync;
    let refused = 0;
    fs.rmSync = (target, options) => {
      if (/[\\/]svg-16-\d+-\d+\.svg$/.test(String(target)) && refused < 2) {
        refused += 1;
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      }
      return realRemove(target, options);
    };
    try {
      await renderSvgPng({ svgPath: user, size: 16, outPath: path.join(dir, 'icon-16.png'), renderer: fakeRenderer(), tempDir: dir });
    } finally {
      fs.rmSync = realRemove;
    }
    assert.equal(refused, 2, 'the removal was refused twice');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => /^svg-16-\d+-\d+\.svg$/.test(name)), [], 'and the copy is gone all the same');
    assert.equal(fs.readFileSync(bystander, 'utf8'), 'not ours');
  });
});
