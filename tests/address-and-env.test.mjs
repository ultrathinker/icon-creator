// A web address and an environment read in the same file look, to an automated plugin scanner, like a credential on
// its way out, whatever the file really does. This plugin has no network code and reads no key, so the two are kept
// apart: the SVG namespace is one constant in scripts/lib/svgns.mjs, and a sample SVG in a script or a test is built
// from it or sits in a fixture file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADDRESS = /https?:\/\//;
const ENVIRONMENT = /process\.env/;

function modulesIn(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') found.push(...modulesIn(full));
    } else if (entry.name.endsWith('.mjs')) {
      found.push(full);
    }
  }
  return found;
}

test('no script or test holds a web address and an environment read together', () => {
  const files = [...modulesIn(path.join(ROOT, 'scripts')), ...modulesIn(path.join(ROOT, 'tests'))];
  assert.ok(files.length > 30, `only ${files.length} files were looked at`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!(ADDRESS.test(text) && ENVIRONMENT.test(text)), `${path.relative(ROOT, file)} holds a web address and an environment read`);
  }
});

test('the one constant that spells the SVG namespace is in a file with no environment read', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'svgns.mjs'), 'utf8');
  assert.ok(ADDRESS.test(text));
  assert.ok(!ENVIRONMENT.test(text));
});
