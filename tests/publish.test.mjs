import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRealParentChain, publishExclusive } from '../scripts/lib/publish.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-pub-'));
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

test('assertRealParentChain accepts a real directory chain and rejects a missing one', () => {
  const dir = tempDir();
  try {
    const real = path.join(dir, 'a', 'b', 'file.png');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    assert.doesNotThrow(() => assertRealParentChain(real));
    assert.throws(() => assertRealParentChain(path.join(dir, 'missing', 'file.png')), /does not exist; create it first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertRealParentChain rejects a symlinked parent directory', { skip: linkSkipReason }, () => {
  const dir = tempDir();
  try {
    const outsideDir = path.join(dir, 'outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    const parent = path.join(dir, 'parent');
    fs.symlinkSync(outsideDir, parent);
    assert.throws(
      () => assertRealParentChain(path.join(parent, 'file.png')),
      /symbolic link or junction: refusing to write through it - pass the real path instead/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertRealParentChain rejects a file sitting where a directory is needed', () => {
  const dir = tempDir();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    assert.throws(
      () => assertRealParentChain(path.join(blocker, 'file.png')),
      /exists and is not a directory/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
