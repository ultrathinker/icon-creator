// Links in the paths a user types, end to end through the real CLI. The
// operating system's own aliases (macOS /var -> /private/var, /tmp, a linked
// project folder, a Windows junction) must not make the tool unusable, while a
// link planted inside the user's project must still be refused. A directory
// link in a temp folder stands in for those aliases, so these tests run the
// same way on Windows, Linux and macOS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverRenderers } from '../scripts/lib/renderers.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { dirLinkSkipReason, makeAliasedTemp, makeDirLink } from './helpers.mjs';
import { glyphIcon, writePng } from './import-helpers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
const FIXTURES = path.resolve('tests/fixtures');
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const browserSkip = discovery.chosen !== null && discovery.chosen.kind === 'browser' ? undefined : 'no headless browser on this machine';
const timeout = 600000;

function runCli(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout, cwd });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('import through a link in the typed paths works, says where it really wrote, and writes there', { skip: dirLinkSkipReason }, () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    const src = writePng(path.join(real, 'logo.png'), 96, 96, glyphIcon(96));
    const out = path.join(linked, 'icons', 'icon-work');
    const { code, stdout, stderr } = runCli(['import', path.join(linked, 'logo.png'), '--out', out, '--name', 'logo']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^Note: The image file is in .* goes through a symbolic link or junction; using its real location /m);
    assert.match(stdout, /^Note: The output folder .* goes through a symbolic link or junction; using its real location /m);
    assert.ok(stdout.includes(fs.realpathSync(real)), 'the real location is printed');
    assert.deepEqual(fs.readdirSync(path.join(real, 'icons', 'icon-work')).sort(), ['logo-master.png', 'logo-master.svg']);
    assert.ok(fs.existsSync(src));
    // A path without any link prints no note.
    // (Typed by its real name, so nothing in it is a link even if the temp folder itself sits behind one.)
    const realFolder = fs.realpathSync(real);
    const plain = runCli(['import', path.join(realFolder, 'logo.png'), '--out', path.join(realFolder, 'plain'), '--name', 'logo']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /^Note:/m);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a link planted inside the project folder is refused by the CLI, the real path is printed, nothing is written', { skip: dirLinkSkipReason }, () => {
  const { base, real } = makeAliasedTemp();
  try {
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    writePng(path.join(project, 'logo.png'), 96, 96, glyphIcon(96));
    makeDirLink(real, path.join(project, 'icon-work'));
    for (const out of ['icon-work', path.join(project, 'icon-work'), path.join('icon-work', 'deeper')]) {
      const { code, stderr } = runCli(['import', 'logo.png', '--out', out, '--name', 'logo'], project);
      assert.equal(code, 1, `--out ${out}`);
      assert.match(stderr, /icon-work is a symbolic link or junction inside the current folder .*refusing to write through it - it points to /);
      assert.ok(stderr.includes(fs.realpathSync(real)), 'the real path to pass instead is printed');
    }
    assert.deepEqual(fs.readdirSync(real), [], 'nothing was written through the link');
    // Passing the real path, as the message says, works.
    const fixed = runCli(['import', 'logo.png', '--out', real, '--name', 'logo'], project);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.deepEqual(fs.readdirSync(real).sort(), ['logo-master.png', 'logo-master.svg']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('render, check and export through a link in the typed paths use the real folder', { skip: dirLinkSkipReason || browserSkip }, () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    const svg = path.join(linked, 'terminal.svg');
    fs.copyFileSync(path.join(FIXTURES, 'terminal.svg'), path.join(real, 'terminal.svg'));

    const rendered = runCli(['render', svg, '--size', '32', '--out', path.join(linked, 'look.png')]);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /Note: The folder of the output file/);
    assert.equal(decodePng(fs.readFileSync(path.join(real, 'look.png'))).width, 32);

    const checked = runCli(['check', svg, '--out', path.join(linked, 'check.png')]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.ok(fs.existsSync(path.join(real, 'check.png')));

    const exported = runCli(['export', svg, '--out', path.join(linked, 'set'), '--name', 'term', '--only', 'master']);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Note: The output folder/);
    assert.ok(exported.stdout.includes(path.join(fs.realpathSync(real), 'set')), 'the export reports the real output folder');
    assert.deepEqual(fs.readdirSync(path.join(real, 'set')).sort(), ['icon-1024.png', 'icon.svg']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a link planted in the project folder is refused by render and export too', { skip: dirLinkSkipReason || browserSkip }, () => {
  const { base, real } = makeAliasedTemp();
  try {
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    fs.copyFileSync(path.join(FIXTURES, 'terminal.svg'), path.join(project, 'terminal.svg'));
    makeDirLink(real, path.join(project, 'redirect'));
    const rendered = runCli(['render', 'terminal.svg', '--size', '16', '--out', path.join('redirect', 'x.png')], project);
    assert.equal(rendered.code, 1);
    assert.match(rendered.stderr, /redirect is a symbolic link or junction inside the current folder/);
    const exported = runCli(['export', 'terminal.svg', '--out', path.join('redirect', 'set'), '--name', 'term', '--only', 'master'], project);
    assert.equal(exported.code, 1);
    assert.match(exported.stderr, /redirect is a symbolic link or junction inside the current folder/);
    assert.deepEqual(fs.readdirSync(real), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
