// Links in the SVG paths a user names as INPUT (the file to render, the sheet's
// concepts, the export master and its small variant). The same rule as for
// output paths: a link in the directories outside the current folder is followed
// once and reported, a link inside the current folder is refused, and the file
// itself must not be a link. Found by the round-15 review, which showed that
// only output paths had been covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInputFile } from '../scripts/lib/publish.mjs';
import { renderSvgPng, discoverRenderers } from '../scripts/lib/renderers.mjs';
import { renderSheet } from '../scripts/lib/sheet.mjs';
import { runExport } from '../scripts/lib/export.mjs';
import { dirLinkSkipReason, makeAliasedTemp, makeDirLink, withCwd } from './helpers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
const FIXTURES = path.resolve('tests/fixtures');
const CLOCK = fs.readFileSync(path.join(FIXTURES, 'clock.svg'), 'utf8');
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const browserSkip = discovery.chosen !== null && discovery.chosen.kind === 'browser' ? undefined : 'no headless browser on this machine';
const stubRenderer = { kind: 'browser', label: 'stub', path: 'nowhere' };

// A file symlink needs a privilege on Windows; probe once and skip politely.
const fileLinkSkipReason = (() => {
  try {
    const { base, real } = makeAliasedTemp('icon-creator-fileprobe-');
    fs.writeFileSync(path.join(real, 't.txt'), 'x');
    fs.symlinkSync(path.join(real, 't.txt'), path.join(base, 'l.txt'));
    fs.rmSync(base, { recursive: true, force: true });
    return dirLinkSkipReason;
  } catch {
    return 'this user cannot create file symlinks here';
  }
})();

function runCli(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 900000, cwd });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A project folder with a planted link `input-link` to a folder that holds clock.svg. */
function plantedProject() {
  const { base, real, linked } = makeAliasedTemp();
  const project = path.join(base, 'project');
  const target = path.join(base, 'target');
  fs.mkdirSync(project);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'clock.svg'), CLOCK);
  fs.writeFileSync(path.join(target, 'small.svg'), CLOCK);
  makeDirLink(target, path.join(project, 'input-link'));
  return { base, real, linked, project, target };
}

const PLANTED = /input-link is a symbolic link or junction inside the current folder .*refusing to read through it - it points to .*pass that real path instead/;

// ---- the resolver ------------------------------------------------------------

test('resolveInputFile follows an outside link once, refuses a planted one, and refuses a link as the file', { skip: fileLinkSkipReason }, async () => {
  const { base, real, linked, project, target } = plantedProject();
  try {
    fs.writeFileSync(path.join(real, 'a.svg'), CLOCK);
    // Outside the current folder (the repository): the alias is a user/OS choice.
    const ok = resolveInputFile(path.join(linked, 'a.svg'));
    assert.equal(ok.linked, true);
    assert.equal(fs.realpathSync(ok.path), fs.realpathSync(path.join(real, 'a.svg')));
    // A missing file is returned as is (reading it reports "no such file").
    assert.equal(path.basename(resolveInputFile(path.join(real, 'missing.svg')).path), 'missing.svg');
    // A leaf link is refused anywhere, naming where it points.
    fs.symlinkSync(path.join(target, 'clock.svg'), path.join(real, 'leaf.svg'));
    assert.throws(() => resolveInputFile(path.join(real, 'leaf.svg')), /leaf\.svg is a symbolic link: refusing to follow it - it points to .*clock\.svg; pass that real path instead/);
    // Inside the current folder a directory link is refused, typed absolute or relative.
    await withCwd(project, () => {
      assert.throws(() => resolveInputFile(path.join(project, 'input-link', 'clock.svg')), PLANTED);
      assert.throws(() => resolveInputFile(path.join('input-link', 'clock.svg')), PLANTED);
      assert.equal(path.basename(resolveInputFile(path.join(target, 'clock.svg')).path), 'clock.svg', 'the real path works');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('renderSvgPng, renderSheet and runExport refuse a source reached through a planted link', { skip: dirLinkSkipReason }, async () => {
  const { base, project, target } = plantedProject();
  try {
    const source = path.join(project, 'input-link', 'clock.svg');
    await withCwd(project, async () => {
      await assert.rejects(renderSvgPng({ svgPath: source, size: 16, outPath: path.join(project, 'x.png'), renderer: stubRenderer, tempDir: base }), PLANTED);
      await assert.rejects(
        renderSheet({ svgPaths: [path.join(target, 'clock.svg'), source], outPath: path.join(project, 's.png'), renderer: stubRenderer, tempDir: base, sizes: [16] }),
        PLANTED,
      );
      for (const options of [{ svgPath: source }, { svgPath: path.join(target, 'clock.svg'), smallPath: path.join(project, 'input-link', 'small.svg') }]) {
        await assert.rejects(
          runExport({ ...options, outDir: path.join(project, 'out'), name: 'x', render: async () => assert.fail('nothing may render'), workDir: path.join(base, 'work') }),
          PLANTED,
        );
      }
    });
    assert.equal(fs.existsSync(path.join(project, 'x.png')), false);
    assert.equal(fs.existsSync(path.join(project, 'out')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an export through an outside link in the SVG path works and reads the real file', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    fs.writeFileSync(path.join(real, 'master.svg'), CLOCK);
    fs.writeFileSync(path.join(real, 'small.svg'), CLOCK);
    const seen = [];
    const result = await runExport({
      svgPath: path.join(linked, 'master.svg'),
      smallPath: path.join(linked, 'small.svg'),
      outDir: path.join(base, 'out'),
      name: 'x',
      targets: ['master'],
      render: async (svg, size, outPath) => {
        seen.push(svg);
        const { encodePng } = await import('../scripts/lib/png.mjs');
        const rgba = Buffer.alloc(size * size * 4);
        for (let y = 2; y < size - 2; y += 1) for (let x = 2; x < size - 2; x += 1) rgba.writeUInt32LE(0xff2060a0, (y * size + x) * 4);
        fs.writeFileSync(outPath, encodePng(size, size, rgba));
      },
      workDir: path.join(base, 'work'),
    });
    assert.deepEqual(result.files.map((file) => file.rel), ['icon.svg', 'icon-1024.png']);
    assert.ok(seen.every((svg) => !svg.split(path.sep).includes('alias')), `the renderer got the real path (${seen})`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- through the real CLI -----------------------------------------------------

test('every CLI command refuses a source reached through a planted link, names the real path and writes nothing', { skip: dirLinkSkipReason || browserSkip }, () => {
  const { base, project, target } = plantedProject();
  try {
    const link = path.join('input-link', 'clock.svg');
    const real = path.join(target, 'clock.svg');
    const attempts = [
      ['render', link, '--size', '16', '--out', 'o-render.png'],
      ['sheet', real, link, '--out', 'o-sheet.png'],
      ['check', link, '--out', 'o-check.png'],
      ['check', real, '--small', link, '--out', 'o-check-small.png'],
      ['export', link, '--out', 'o-export', '--name', 'x', '--only', 'master'],
      ['export', real, '--small', link, '--out', 'o-export-small', '--name', 'x', '--only', 'master'],
    ];
    for (const args of attempts) {
      const { code, stderr } = runCli(args, project);
      assert.equal(code, 1, args.join(' '));
      assert.match(stderr, PLANTED, args.join(' '));
      assert.ok(stderr.includes(fs.realpathSync(target)), `the real path is named: ${args.join(' ')}`);
    }
    assert.deepEqual(fs.readdirSync(project).sort(), ['input-link'], 'nothing was written into the project');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('every CLI command reads a source through an outside link, says where it really is, and works', { skip: dirLinkSkipReason || browserSkip }, () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    fs.writeFileSync(path.join(real, 'clock.svg'), CLOCK);
    fs.writeFileSync(path.join(real, 'small.svg'), CLOCK);
    const svg = path.join(linked, 'clock.svg');
    const small = path.join(linked, 'small.svg');
    const out = (name) => path.join(real, name); // typed by its real name: no output note
    const noteSvg = /^Note: The folder of the SVG file .* goes through a symbolic link or junction; using its real location /m;

    const rendered = runCli(['render', svg, '--size', '16', '--out', out('r.png')]);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, noteSvg);
    assert.ok(rendered.stdout.includes(fs.realpathSync(real)));

    const sheeted = runCli(['sheet', svg, small, '--out', out('s.png'), '--sizes', '16']);
    assert.equal(sheeted.code, 0, sheeted.stderr);
    assert.equal((sheeted.stdout.match(/^Note: The folder of the SVG file/gm) ?? []).length, 2, 'one note per linked SVG');

    const checked = runCli(['check', svg, '--small', small, '--out', out('c.png')]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.match(checked.stdout, noteSvg);
    assert.match(checked.stdout, /^Note: The folder of the small-variant SVG /m);

    const exported = runCli(['export', svg, '--small', small, '--out', out('set'), '--name', 'x', '--only', 'master']);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, noteSvg);
    assert.match(exported.stdout, /^Note: The folder of the small-variant SVG /m);
    assert.deepEqual(fs.readdirSync(out('set')).sort(), ['icon-1024.png', 'icon.svg']);

    // A path typed by its real name prints no note at all.
    // (Both paths typed by their real names: the temp folder itself may sit behind a link.)
    const realFolder = fs.realpathSync(real);
    const quiet = runCli(['render', path.join(realFolder, 'clock.svg'), '--size', '16', '--out', path.join(realFolder, 'q.png')]);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /^Note:/m);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a symbolic link as the SVG file itself is refused by the CLI', { skip: fileLinkSkipReason || browserSkip }, () => {
  const { base, project, target } = plantedProject();
  try {
    const leaf = path.join(project, 'leaf.svg');
    fs.symlinkSync(path.join(target, 'clock.svg'), leaf);
    const { code, stderr } = runCli(['render', 'leaf.svg', '--size', '16', '--out', 'o.png'], project);
    assert.equal(code, 1);
    assert.match(stderr, /leaf\.svg is a symbolic link: refusing to follow it - it points to .*clock\.svg; pass that real path instead/);
    assert.equal(fs.existsSync(path.join(project, 'o.png')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
