import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePng } from '../scripts/lib/png.mjs';
import {
  runExport,
  planFiles,
  sanitizeName,
  titleOrDefault,
  webmanifestText,
  headHtmlText,
  desktopEntryText,
  isRasterMaster,
  TARGETS,
} from '../scripts/lib/export.mjs';
import { parseIco } from '../scripts/lib/ico.mjs';
import { parseIcns } from '../scripts/lib/icns.mjs';
import { removeTree, dirLinkSkipReason, makeAliasedTemp, makeDirLink, withCwd } from './helpers.mjs';

const MASTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<rect x="8" y="8" width="240" height="240" rx="56" fill="#123456"/></svg>';
const SMALL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<circle cx="128" cy="128" r="110" fill="#654321"/></svg>';

/** A valid icon-shaped PNG: opaque rounded area, transparent border/corners. */
function solidPng(size, shade) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = Math.max(1, Math.round(size / 16));
  for (let y = inset; y < size - inset; y += 1) {
    for (let x = inset; x < size - inset; x += 1) {
      const o = (y * size + x) * 4;
      rgba[o] = shade;
      rgba[o + 1] = 100;
      rgba[o + 2] = 180;
      rgba[o + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/** Fake renderer: writes a valid PNG of the requested size, records calls. */
function makeFakeRenderer() {
  const calls = [];
  const render = async (svgPath, size, outPath) => {
    calls.push({ svg: path.basename(svgPath), size });
    fs.writeFileSync(outPath, solidPng(size, path.basename(svgPath).includes('small') ? 90 : 30));
  };
  return { render, calls };
}

async function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-test-'));
  try {
    return await run(dir);
  } finally {
    removeTree(dir);
  }
}

test('sanitizeName accepts safe names and rejects dangerous ones', () => {
  assert.equal(sanitizeName('terminal-app'), 'terminal-app');
  assert.equal(sanitizeName('App_2.v2'), 'App_2.v2');
  for (const bad of ['../escape', 'a/b', 'a\\b', '.hidden', 'has space', '', 'x'.repeat(65), '..']) {
    assert.throws(() => sanitizeName(bad), /not a safe file name/, JSON.stringify(bad));
  }
});

test('titleOrDefault turns a slug into words', () => {
  assert.equal(titleOrDefault('terminal-app'), 'Terminal App');
  assert.equal(titleOrDefault('my_app'), 'My App');
});

test('planFiles lays out the full tree with stable names', () => {
  const files = planFiles('app', TARGETS);
  const rels = files.map((file) => file.rel);
  assert.ok(rels.includes('icon.svg'));
  assert.ok(rels.includes('icon-1024.png'));
  assert.ok(rels.includes('windows/app.ico'));
  assert.ok(rels.includes('macos/app.icns'));
  assert.ok(rels.includes('linux/hicolor/22x22/apps/app.png'));
  assert.ok(rels.includes('linux/hicolor/512x512/apps/app.png'));
  assert.ok(rels.includes('linux/scalable/apps/app.svg'));
  assert.ok(rels.includes('linux/app.desktop'));
  assert.ok(rels.includes('web/favicon.svg'));
  assert.ok(rels.includes('web/favicon.ico'));
  assert.ok(rels.includes('web/apple-touch-icon.png'));
  assert.ok(rels.includes('web/icon-192.png'));
  assert.ok(rels.includes('web/icon-512.png'));
  assert.ok(rels.includes('web/site.webmanifest'));
  assert.ok(rels.includes('web/head.html'));
  assert.equal(rels.length, new Set(rels).size, 'file names must be unique');
});

test('a full export writes every planned file with valid containers', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const fake = makeFakeRenderer();
    const outDir = path.join(dir, 'out');
    const result = await runExport({
      svgPath: master,
      outDir,
      name: 'sample',
      title: 'Sample App',
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    assert.equal(result.files.length, planFiles('sample', TARGETS).length);
    for (const file of result.files) {
      assert.ok(fs.existsSync(path.join(outDir, file.rel)), `${file.rel} should exist`);
    }
    // Windows ICO: 7 PNG entries, 256 stored as 0.
    const ico = parseIco(fs.readFileSync(path.join(outDir, 'windows/sample.ico')));
    assert.deepEqual(ico.entries.map((e) => e.declaredWidth), [16, 24, 32, 48, 64, 128, 256]);
    // macOS ICNS: all 11 chunks.
    const icns = parseIcns(fs.readFileSync(path.join(outDir, 'macos/sample.icns')));
    assert.equal(icns.chunks.length, 11);
    // The manifest parses, names the app and lists exactly the two icon
    // entries the web set defines - both of which must exist on disk.
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'web/site.webmanifest'), 'utf8'));
    assert.equal(manifest.name, 'Sample App');
    assert.deepEqual(manifest.icons, [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
    for (const icon of manifest.icons) {
      assert.ok(fs.existsSync(path.join(outDir, 'web', icon.src.replace(/^\//, ''))), icon.src);
    }
    // head.html links resolve.
    for (const match of headHtmlText().matchAll(/href="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(outDir, 'web', match[1].replace(/^\//, ''))), match[1]);
    }
    // Desktop entry contains the icon key.
    assert.match(fs.readFileSync(path.join(outDir, 'linux/sample.desktop'), 'utf8'), /Icon=sample/);
    // Renders are per unique size only.
    assert.equal(new Set(fake.calls.map((c) => c.size)).size, fake.calls.length);
  });
});

test('a small variant is used for sizes <= 32 px only', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    const small = path.join(dir, 'small-variant.svg');
    fs.writeFileSync(master, MASTER_SVG);
    fs.writeFileSync(small, SMALL_SVG);
    const fake = makeFakeRenderer();
    const outDir = path.join(dir, 'out');
    await runExport({
      svgPath: master,
      smallPath: small,
      outDir,
      name: 'sample',
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    const bySize = new Map(fake.calls.map((call) => [call.size, call.svg]));
    assert.equal(bySize.get(16), 'small-variant.svg');
    assert.equal(bySize.get(24), 'small-variant.svg');
    assert.equal(bySize.get(32), 'small-variant.svg');
    assert.equal(bySize.get(48), 'master.svg');
    assert.equal(bySize.get(1024), 'master.svg');
    // and the 16px payload inside the ico is the small variant's colour
    const ico = parseIco(fs.readFileSync(path.join(outDir, 'windows/sample.ico')));
    assert.equal(ico.entries[0].declaredWidth, 16);
  });
});

test('export refuses to overwrite existing files without --force', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(path.join(outDir, 'web'), { recursive: true });
    const existing = path.join(outDir, 'web/favicon.svg');
    fs.writeFileSync(existing, 'precious');
    const fake = makeFakeRenderer();
    await assert.rejects(
      runExport({ svgPath: master, outDir, name: 'sample', render: fake.render, workDir: path.join(dir, 'work') }),
      /refusing to write into .*already holds/s,
    );
    assert.equal(fs.readFileSync(existing, 'utf8'), 'precious');
    assert.equal(fake.calls.length, 0, 'no renders should happen when refusing');
    // --force goes through.
    await runExport({
      svgPath: master,
      outDir,
      name: 'sample',
      force: true,
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    assert.notEqual(fs.readFileSync(existing, 'utf8'), 'precious');
  });
});

test('export refuses a non-empty output folder even with unrelated files', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'sentinel.txt'), 'keep me');
    const fake = makeFakeRenderer();
    await assert.rejects(
      runExport({ svgPath: master, outDir, name: 'sample', render: fake.render, workDir: path.join(dir, 'work') }),
      /refusing to write into .*sentinel\.txt/s,
    );
    assert.equal(fs.readFileSync(path.join(outDir, 'sentinel.txt'), 'utf8'), 'keep me');
    assert.equal(fs.readdirSync(outDir).length, 1, 'nothing else was written');
    assert.equal(fake.calls.length, 0);
    // --force writes into the populated folder and leaves the sentinel alone.
    await runExport({
      svgPath: master,
      outDir,
      name: 'sample',
      force: true,
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'sentinel.txt'), 'utf8'), 'keep me');
    assert.ok(fs.existsSync(path.join(outDir, 'web/favicon.svg')));
  });
});

test('export rejects a render with an opaque background', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const opaque = (svgPath, size, outPath) => {
      const rgba = Buffer.alloc(size * size * 4);
      for (let i = 0; i < size * size; i += 1) {
        rgba[i * 4] = 200;
        rgba[i * 4 + 1] = 100;
        rgba[i * 4 + 2] = 50;
        rgba[i * 4 + 3] = 255;
      }
      fs.writeFileSync(outPath, encodePng(size, size, rgba));
    };
    await assert.rejects(
      runExport({ svgPath: master, outDir: path.join(dir, 'out'), name: 'sample', render: opaque, workDir: path.join(dir, 'work') }),
      /opaque background/,
    );
  });
});

const linkSkipReason = (() => {
  // Junctions need no privileges on Windows; POSIX needs symlink rights.
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-linkprobe-'));
    const target = path.join(probe, 'target');
    const link = path.join(probe, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(probe, { recursive: true, force: true });
    return undefined;
  } catch {
    return 'this user cannot create links on this platform';
  }
})();

test('export refuses to follow a junction or symlink out of the output folder', { skip: linkSkipReason }, async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(outDir, 'web'), process.platform === 'win32' ? 'junction' : 'dir');
    const fake = makeFakeRenderer();
    // Without --force the non-empty guard already refuses (the link counts as
    // an entry); --force is the path that reaches the directory walk, and it
    // must still refuse to follow the link out of the output folder.
    await assert.rejects(
      runExport({
        svgPath: master,
        outDir,
        name: 'sample',
        force: true,
        render: fake.render,
        workDir: path.join(dir, 'work'),
      }),
      /symbolic link or junction|outside the output folder/,
    );
    assert.equal(fs.readdirSync(outside).length, 0, 'nothing may be written through the link');
  });
});

test('export rejects a bad master SVG before any render', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><script>x()</script></svg>');
    const fake = makeFakeRenderer();
    await assert.rejects(
      runExport({ svgPath: master, outDir: path.join(dir, 'out'), name: 'sample', render: fake.render, workDir: path.join(dir, 'work') }),
      /cannot be exported/,
    );
    assert.equal(fake.calls.length, 0);
  });
});

test('export rejects an unsafe name without touching the disk', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    await assert.rejects(
      runExport({
        svgPath: master,
        outDir: path.join(dir, 'out'),
        name: '../pwned',
        render: makeFakeRenderer().render,
        workDir: path.join(dir, 'work'),
      }),
      /not a safe file name/,
    );
  });
});

test('target subsets produce only their files', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out-web');
    const result = await runExport({
      svgPath: master,
      outDir,
      name: 'sample',
      targets: ['web'],
      render: makeFakeRenderer().render,
      workDir: path.join(dir, 'work'),
    });
    for (const file of result.files) {
      assert.ok(file.rel.startsWith('web/'), file.rel);
    }
    assert.ok(!fs.existsSync(path.join(outDir, 'windows')));
  });
});

test('unknown targets are refused', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    await assert.rejects(
      runExport({
        svgPath: master,
        outDir: path.join(dir, 'out'),
        name: 'sample',
        targets: ['windows', 'blackberry'],
        render: makeFakeRenderer().render,
        workDir: path.join(dir, 'work'),
      }),
      /Unknown target "blackberry"/,
    );
  });
});

const fileLinkSkipReason = (() => {
  // Creating a file symlink needs privileges on Windows (admin or Developer
  // Mode); hardlinks need an NTFS-like filesystem. Probe both once.
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-flink-'));
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    fs.linkSync(target, path.join(dir, 'hard.txt'));
    fs.rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch {
    return 'this user cannot create file symlinks/hardlinks here';
  }
})();

test('export refuses a symbolic link planted at a planned output file', { skip: fileLinkSkipReason }, async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outside = path.join(dir, 'outside-sentinel.txt');
    fs.writeFileSync(outside, 'OUTSIDE_SENTINEL');
    fs.symlinkSync(outside, path.join(outDir, 'icon.svg'));
    const fake = makeFakeRenderer();
    await assert.rejects(
      runExport({
        svgPath: master,
        outDir,
        name: 'sample',
        targets: ['master'],
        force: true,
        render: fake.render,
        workDir: path.join(dir, 'work'),
      }),
      /symbolic link: refusing to write through it/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_SENTINEL');
  });
});

test('export through a hardlink replaces the entry, never the linked file', { skip: fileLinkSkipReason }, async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outside = path.join(dir, 'outside-hardlinked.txt');
    fs.writeFileSync(outside, 'OUTSIDE_HARDLINK_SENTINEL');
    fs.linkSync(outside, path.join(outDir, 'icon.svg'));
    const fake = makeFakeRenderer();
    await runExport({
      svgPath: master,
      outDir,
      name: 'sample',
      targets: ['master'],
      force: true,
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    // The exported entry exists with new content...
    assert.equal(fs.readFileSync(path.join(outDir, 'icon.svg'), 'utf8'), MASTER_SVG);
    // ...and the file it used to share an inode with is untouched.
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_HARDLINK_SENTINEL');
  });
});

test('export refuses a link planted in the project folder above a new output root', { skip: linkSkipReason }, async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outside = path.join(dir, 'parent-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'parent-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const fake = makeFakeRenderer();
    // `dir` is the current folder, i.e. the user's project; the link lives inside it.
    await withCwd(dir, async () => {
      await assert.rejects(
        runExport({
          svgPath: master,
          outDir: path.join(dir, 'parent-link', 'new-output'),
          name: 'sample',
          render: fake.render,
          workDir: path.join(dir, 'work'),
        }),
        /parent-link is a symbolic link or junction inside the current folder .*it points to .*pass that real path instead/,
      );
    });
    assert.equal(fs.readdirSync(outside).length, 0, 'nothing may be created through the link');
    // Renders into the scratch work dir are fine; no output file may exist.
    assert.equal(fs.existsSync(path.join(dir, 'parent-link', 'new-output')), false);
  });
});

test('export works through a link in the path the user named and reports the real folder', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    const master = path.join(base, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const result = await runExport({
      svgPath: master,
      outDir: path.join(linked, 'icons', 'sample'),
      name: 'sample',
      render: makeFakeRenderer().render,
      workDir: path.join(base, 'work'),
    });
    assert.ok(fs.existsSync(path.join(real, 'icons', 'sample', 'windows', 'sample.ico')), 'files land in the real folder');
    assert.equal(fs.realpathSync(result.outDir), fs.realpathSync(path.join(real, 'icons', 'sample')));
    assert.ok(!result.outDir.split(path.sep).includes('alias'), `outDir is the real path (${result.outDir})`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a link planted below the output folder is still refused when the folder itself is reached through a link', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    const master = path.join(base, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(real, 'out'));
    makeDirLink(outside, path.join(real, 'out', 'web'));
    await assert.rejects(
      runExport({
        svgPath: master,
        outDir: path.join(linked, 'out'),
        name: 'sample',
        force: true,
        render: makeFakeRenderer().render,
        workDir: path.join(base, 'work'),
      }),
      /symbolic link or junction|outside the output folder/,
    );
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written through the planted link');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('text artifacts have the documented shape', () => {
  assert.match(webmanifestText('My App', 'my-app'), /"name": "My App"/);
  assert.match(headHtmlText(), /apple-touch-icon/);
  const desktop = desktopEntryText('My App', 'my-app');
  assert.match(desktop, /\[Desktop Entry\]/);
  assert.match(desktop, /Icon=my-app/);
  assert.match(desktop, /Exec=my-app/);
  assert.doesNotMatch(desktop, /\r/);
});

// ---- raster masters (the wrapper `import` writes around a user's image) ----

const RASTER_MASTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<image href="data:image/png;base64,iVBORw0KGgo=" x="0" y="0" width="64" height="64"/></svg>';

test('isRasterMaster is true only for documents that draw nothing but images', () => {
  assert.equal(isRasterMaster(['svg', 'image']), true);
  assert.equal(isRasterMaster(['svg', 'defs', 'g', 'image', 'image']), true);
  assert.equal(isRasterMaster(['svg']), false);
  assert.equal(isRasterMaster(['svg', 'rect']), false);
  assert.equal(isRasterMaster(['svg', 'image', 'path']), false, 'an image plus drawn shapes is still a vector source');
});

test('planFiles leaves out every vector file for a raster master', () => {
  const rels = planFiles('app', TARGETS, { vector: false }).map((file) => file.rel);
  for (const vectorFile of ['icon.svg', 'web/favicon.svg', 'linux/scalable/apps/app.svg']) {
    assert.ok(!rels.includes(vectorFile), `${vectorFile} must not be planned`);
  }
  for (const kept of ['icon-1024.png', 'windows/app.ico', 'macos/app.icns', 'linux/hicolor/512x512/apps/app.png', 'web/favicon.ico', 'web/head.html']) {
    assert.ok(rels.includes(kept), `${kept} must still be planned`);
  }
  assert.equal(planFiles('app', TARGETS).length - rels.length, 3, 'exactly the three vector files differ');
  assert.doesNotMatch(headHtmlText({ vector: false }), /favicon\.svg/);
});

test('exporting a raster master skips the vector files and says which', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, RASTER_MASTER_SVG);
    const fake = makeFakeRenderer();
    const result = await runExport({
      svgPath: master,
      outDir: path.join(dir, 'out'),
      name: 'photo-app',
      render: fake.render,
      workDir: path.join(dir, 'work'),
    });
    assert.equal(result.rasterMaster, true);
    assert.deepEqual(result.skipped, ['icon.svg', 'linux/scalable/apps/photo-app.svg', 'web/favicon.svg']);
    const rels = result.files.map((file) => file.rel);
    assert.ok(!rels.some((rel) => rel.endsWith('.svg')));
    assert.ok(rels.includes('icon-1024.png') && rels.includes('windows/photo-app.ico'));
    assert.ok(!fs.readFileSync(path.join(dir, 'out', 'web', 'head.html'), 'utf8').includes('favicon.svg'));
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'icon.svg')));
  });
});

test('a drawn master still gets every vector file and an empty skipped list', async () => {
  await withTempDir(async (dir) => {
    const master = path.join(dir, 'master.svg');
    fs.writeFileSync(master, MASTER_SVG);
    const result = await runExport({
      svgPath: master,
      outDir: path.join(dir, 'out'),
      name: 'drawn',
      render: makeFakeRenderer().render,
      workDir: path.join(dir, 'work'),
    });
    assert.equal(result.rasterMaster, false);
    assert.deepEqual(result.skipped, []);
    const rels = result.files.map((file) => file.rel);
    for (const vectorFile of ['icon.svg', 'web/favicon.svg', 'linux/scalable/apps/drawn.svg']) {
      assert.ok(rels.includes(vectorFile), `${vectorFile} is written for a drawn master`);
    }
    assert.match(fs.readFileSync(path.join(dir, 'out', 'web', 'head.html'), 'utf8'), /favicon\.svg/);
  });
});
