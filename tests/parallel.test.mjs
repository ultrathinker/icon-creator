// Parallel safety: the skill can start one subagent per icon, so several tool
// commands run at the same moment against different folders. Nothing shared
// (scratch folders, browser profiles, temp files, parent directories) may
// collide. These tests start real processes concurrently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverRenderers } from '../scripts/lib/renderers.mjs';
import { decodePng, analyzeRgba } from '../scripts/lib/png.mjs';
import { withTemp, writePng, glyphIcon, ringOnBackground } from './import-helpers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
const FIXTURES = path.resolve('tests/fixtures');
// Eight renders per export (the master and the Windows icon): the point is that
// concurrent processes do not disturb each other, not how much they render, and
// a slow CI runner needs seconds per browser launch.
const ONLY = 'master,windows';
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const hasRenderer = discovery.chosen !== null;
const rendererSkip = hasRenderer ? undefined : 'no renderer on this machine';

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, args }));
  });
}

const read = (file) => fs.readFileSync(file);

test('several imports into one fresh folder at the same time do not collide', async () => {
  await withTemp(async (dir) => {
    const work = path.join(dir, 'icons', 'icon-work');
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const sources = names.map((name, index) =>
      writePng(path.join(dir, `${name}.png`), 96 + index, 96 + index, index % 2 === 0 ? glyphIcon(96 + index) : ringOnBackground(96 + index, [255, 255, 255, 255])),
    );
    const results = await Promise.all(sources.map((src, index) => runAsync(['import', src, '--out', work, '--name', names[index]])));
    for (const result of results) assert.equal(result.code, 0, `${result.args.slice(0, 2).join(' ')}: ${result.stderr}`);
    assert.deepEqual(fs.readdirSync(work).sort(), names.flatMap((name) => [`${name}-master.png`, `${name}-master.svg`]).sort());
    names.forEach((name, index) => {
      const master = decodePng(read(path.join(work, `${name}-master.png`)));
      assert.equal(master.width, 96 + index, `${name} kept its own size (no cross-talk between processes)`);
      assert.deepEqual(analyzeRgba(master.width, master.height, master.rgba).cornerAlphas, [0, 0, 0, 0]);
    });
  });
});

test('concurrent render, sheet, check and export commands produce exactly what a lone run produces', { skip: rendererSkip }, async () => {
  await withTemp(async (dir) => {
    const terminal = path.join(FIXTURES, 'terminal.svg');
    const clock = path.join(FIXTURES, 'clock.svg');
    const root = path.join(dir, 'icons'); // does not exist yet: the exports below create it concurrently
    const concurrent = await Promise.all([
      runAsync(['export', terminal, '--out', path.join(root, 'app-1'), '--name', 'app', '--only', ONLY]),
      runAsync(['export', clock, '--out', path.join(root, 'app-2'), '--name', 'app', '--only', ONLY]),
      runAsync(['check', terminal, '--out', path.join(dir, 'check.png')]),
      runAsync(['sheet', terminal, clock, '--out', path.join(dir, 'sheet.png'), '--sizes', '32,16']),
      runAsync(['render', clock, '--size', '256', '--out', path.join(dir, 'clock-256.png')]),
    ]);
    for (const result of concurrent) assert.equal(result.code, 0, `${result.args.slice(0, 2).join(' ')} failed: ${result.stderr}`);

    // The same commands, run alone afterwards, must give byte-identical files.
    const lone1 = await runAsync(['export', terminal, '--out', path.join(dir, 'lone-1'), '--name', 'app', '--only', ONLY]);
    const lone2 = await runAsync(['export', clock, '--out', path.join(dir, 'lone-2'), '--name', 'app', '--only', ONLY]);
    const loneRender = await runAsync(['render', clock, '--size', '256', '--out', path.join(dir, 'lone-clock-256.png')]);
    for (const result of [lone1, lone2, loneRender]) assert.equal(result.code, 0, result.stderr);
    for (const relative of ['icon-1024.png', 'icon.svg', 'windows/app.ico']) {
      assert.deepEqual(read(path.join(root, 'app-1', relative)), read(path.join(dir, 'lone-1', relative)), `app-1/${relative} (terminal)`);
      assert.deepEqual(read(path.join(root, 'app-2', relative)), read(path.join(dir, 'lone-2', relative)), `app-2/${relative} (clock)`);
    }
    assert.notDeepEqual(read(path.join(root, 'app-1', 'icon-1024.png')), read(path.join(root, 'app-2', 'icon-1024.png')), 'the two icons really differ');
    assert.deepEqual(read(path.join(dir, 'clock-256.png')), read(path.join(dir, 'lone-clock-256.png')));
    assert.ok(read(path.join(dir, 'check.png')).length > 1000 && read(path.join(dir, 'sheet.png')).length > 1000);
  });
});
