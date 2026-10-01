import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOutputFile, resolveNamedPath, linkNote, publishExclusive } from '../scripts/lib/publish.mjs';
import { dirLinkSkipReason, makeAliasedTemp, makeDirLink, withCwd } from './helpers.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-pub-'));
}

/** A temp folder under its real name (on macOS os.tmpdir() sits behind /var -> /private/var). */
function realTempDir() {
  return fs.realpathSync(tempDir());
}

const linkSkipReason = (() => {
  try {
    const dir = tempDir();
    const target = path.join(dir, 't');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'l'));
    fs.rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch {
    return 'this user cannot create symlinks here';
  }
})();

test('publishExclusive writes the content and leaves no staging entry behind', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'out.bin');
    publishExclusive(target, Buffer.from('payload'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
    assert.deepEqual(fs.readdirSync(dir), ['out.bin']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishExclusive replaces an existing target entry, not its hardlink twin', () => {
  const dir = tempDir();
  try {
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'precious');
    const target = path.join(dir, 'icon.svg');
    try {
      fs.linkSync(outside, target);
    } catch {
      return; // filesystem without hardlinks; the symlink test covers aliases
    }
    publishExclusive(target, Buffer.from('new icon'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'new icon');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishExclusive refuses a pre-planted staging entry instead of writing through it', { skip: linkSkipReason }, () => {
  const dir = tempDir();
  try {
    const outside = path.join(dir, 'outside-sentinel.txt');
    fs.writeFileSync(outside, 'precious');
    const target = path.join(dir, 'out.png');
    const plantedStaging = path.join(dir, 'out.png.tmp-planted');
    fs.symlinkSync(outside, plantedStaging);
    assert.throws(
      () => publishExclusive(target, Buffer.from('payload'), { stagedPath: plantedStaging }),
      /EEXIST/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOutputFile accepts a real directory chain and rejects a missing one', () => {
  const dir = realTempDir();
  try {
    const real = path.join(dir, 'a', 'b', 'file.png');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    const resolved = resolveOutputFile(real);
    assert.equal(resolved.path, real);
    assert.equal(resolved.linked, false);
    assert.throws(() => resolveOutputFile(path.join(dir, 'missing', 'file.png')), /does not exist; create it first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOutputFile rejects a file sitting where a directory is needed', () => {
  const dir = realTempDir();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    assert.throws(() => resolveOutputFile(path.join(blocker, 'file.png')), /exists and is not a directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- links in the path the user named (macOS /var -> /private/var) ---------

test('a link in the part of the path the user named is followed once, reported, and works', { skip: dirLinkSkipReason }, () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    fs.mkdirSync(path.join(real, 'out'));
    // The working directory is the repository, far away from this folder, so the
    // link is part of a location the user chose, like /var/folders behind /var.
    const resolved = resolveNamedPath(path.join(linked, 'out'));
    assert.equal(resolved.linked, true);
    assert.equal(fs.realpathSync(resolved.path), fs.realpathSync(path.join(real, 'out')));
    assert.ok(!resolved.path.split(path.sep).includes('alias'), `the result is the real location (${resolved.path})`);
    assert.match(linkNote('The output folder', resolved), /^Note: The output folder .* goes through a symbolic link or junction; using its real location /);
    // A file below the link resolves the same way, and a missing tail stays lexical.
    const file = resolveOutputFile(path.join(linked, 'out', 'file.png'));
    assert.equal(fs.realpathSync(path.dirname(file.path)), fs.realpathSync(path.join(real, 'out')));
    assert.equal(path.basename(file.path), 'file.png');
    const fresh = resolveNamedPath(path.join(linked, 'new', 'deeper'));
    assert.equal(fresh.linked, true);
    assert.equal(fresh.path, path.join(fs.realpathSync(real), 'new', 'deeper'));
    // Links that point at links are followed all the way.
    const second = path.join(base, 'alias2');
    makeDirLink(linked, second);
    assert.equal(fs.realpathSync(resolveNamedPath(path.join(second, 'out')).path), fs.realpathSync(path.join(real, 'out')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a link planted inside the current folder is refused, with the real path to pass instead', { skip: dirLinkSkipReason }, async () => {
  const { base, real } = makeAliasedTemp();
  try {
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    makeDirLink(real, path.join(project, 'icon-work'));
    await withCwd(project, () => {
      const attempt = () => resolveOutputFile(path.join(project, 'icon-work', 'sheet.png'));
      assert.throws(attempt, /icon-work is a symbolic link or junction inside the current folder .*: refusing to write through it - it points to /);
      assert.throws(attempt, new RegExp(fs.realpathSync(real).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/\\\\/g, '\\\\+') + '.*pass that real path instead'));
      // The same link typed as a relative path is refused as well.
      assert.throws(() => resolveOutputFile(path.join('icon-work', 'sheet.png')), /inside the current folder/);
      // A real folder next to it is fine.
      fs.mkdirSync(path.join(project, 'plain'));
      const plain = resolveOutputFile(path.join('plain', 'sheet.png'));
      assert.equal(fs.realpathSync(path.dirname(plain.path)), fs.realpathSync(path.join(project, 'plain')));
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a project reached through a link is not mistaken for a planted link, but a link inside it still is', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    const project = path.join(real, 'project');
    fs.mkdirSync(path.join(project, 'icons'), { recursive: true });
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await withCwd(project, () => {
      // Typed through the alias: the alias is resolved (it lives above the project) ...
      const ok = resolveOutputFile(path.join(linked, 'project', 'icons', 'sheet.png'));
      assert.equal(ok.linked, true);
      assert.equal(fs.realpathSync(path.dirname(ok.path)), fs.realpathSync(path.join(project, 'icons')));
      // ... and a link planted in the project is refused even when reached the same way.
      makeDirLink(elsewhere, path.join(project, 'redirect'));
      assert.throws(
        () => resolveOutputFile(path.join(linked, 'project', 'redirect', 'sheet.png')),
        /redirect is a symbolic link or junction inside the current folder/,
      );
    });
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('working inside a project folder that is itself reached through a link works, and a planted link in it is still refused', { skip: dirLinkSkipReason }, async () => {
  const { base, real, linked } = makeAliasedTemp();
  try {
    fs.mkdirSync(path.join(real, 'project', 'icons'), { recursive: true });
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // The shell's current folder is typed through the link (a Windows junction
    // keeps that spelling; POSIX reports the real folder - both must work).
    await withCwd(path.join(linked, 'project'), () => {
      const ok = resolveOutputFile(path.join('icons', 'sheet.png'));
      assert.equal(fs.realpathSync(path.dirname(ok.path)), fs.realpathSync(path.join(real, 'project', 'icons')));
      makeDirLink(elsewhere, path.join(real, 'project', 'redirect'));
      assert.throws(() => resolveOutputFile(path.join('redirect', 'sheet.png')), /redirect is a symbolic link or junction inside the current folder/);
      assert.throws(
        () => resolveOutputFile(path.join(linked, 'project', 'redirect', 'sheet.png')),
        /redirect is a symbolic link or junction inside the current folder/,
      );
    });
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
