// CLI-level tests: the --renderer option end to end, run through the real
// entry point the same way a user (or the skill) invokes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverRenderers } from '../scripts/lib/renderers.mjs';

const CLI = path.resolve('scripts/icons.mjs');
const discovery = discoverRenderers({ platform: process.platform, pathValue: process.env.PATH ?? '' });
const hasRenderer = discovery.chosen !== null;

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('an invalid --renderer is rejected by every command that accepts it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-cli-'));
  try {
    const unused = path.join(base, 'unused.png');
    for (const [subcommand, args] of [
      ['render', ['render', 'tests/fixtures/clock.svg', '--size', '16', '--out', unused, '--renderer', 'definitely-not']],
      ['sheet', ['sheet', 'tests/fixtures/clock.svg', '--out', unused, '--renderer', 'definitely-not']],
      ['check', ['check', 'tests/fixtures/clock.svg', '--out', unused, '--renderer', 'definitely-not']],
    ]) {
      const { code, stderr } = runCli(args);
      assert.notEqual(code, 0, `${subcommand} must fail on an unknown renderer`);
      assert.match(stderr, /--renderer definitely-not was not found/, `${subcommand} stderr`);
      assert.ok(!fs.existsSync(unused), `${subcommand} must not write output`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the CLI rejects an SVG whose real root is masked by a comment', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-cli-'));
  try {
    const svg = path.join(base, 'comment-root.svg');
    fs.writeFileSync(
      svg,
      '<!-- <svg viewBox="0 0 256 256"></svg> -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 256"><rect x="8" y="8" width="284" height="240" rx="44" fill="#2563eb"/></svg>',
    );
    const out = path.join(base, 'out.png');
    const { code, stderr } = runCli(['render', svg, '--size', '16', '--out', out]);
    assert.notEqual(code, 0);
    assert.match(stderr, /square/);
    assert.equal(fs.existsSync(out), false, 'no output may be produced');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the CLI rejects an SVG whose real root hides behind an unterminated processing instruction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-cli-'));
  try {
    const svg = path.join(base, 'pi-root.svg');
    fs.writeFileSync(
      svg,
      '<?review\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"></svg>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 256"><rect x="8" y="8" width="284" height="240" rx="44" fill="#2563eb"/></svg>',
    );
    const out = path.join(base, 'out.png');
    const { code, stderr } = runCli(['render', svg, '--size', '16', '--out', out]);
    assert.notEqual(code, 0);
    assert.match(stderr, /processing instruction/);
    assert.equal(fs.existsSync(out), false, 'no output may be produced');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an explicit --renderer keeps working through the whole pipeline', { skip: hasRenderer ? undefined : 'no renderer on this machine' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-creator-cli-'));
  try {
    const out = path.join(base, 'explicit.png');
    const { code, stdout } = runCli([
      'render',
      'tests/fixtures/clock.svg',
      '--size',
      '16',
      '--out',
      out,
      '--renderer',
      discovery.chosen.name,
    ]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /corners alpha \[0 0 0 0\]/);
    assert.ok(fs.existsSync(out));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
