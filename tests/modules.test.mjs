// Run: node --test tests/
// The browser loads js/ as one ES module graph, so a single syntax error, bad
// relative path or missing named export blanks every page. The unit tests only
// import the pure lib/ modules, so check the whole graph statically here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
const FILES = walk(join(ROOT, 'js'));

function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const [local, alias] = part.trim().split(/\s+as\s+/);
      if (local) names.add((alias || local).trim());
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

test('every js/ module parses', () => {
  for (const file of FILES) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}\n${r.stderr}`);
  }
});

test('every relative import resolves to a real file and export', () => {
  const problems = [];
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = join(dirname(file), m[3]);
      if (!existsSync(target)) { problems.push(`${file}: missing ${m[3]}`); continue; }
      const have = exportsOf(target);
      const want = (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (m[1]) want.push('default');
      for (const name of want) if (!have.has(name)) problems.push(`${file}: ${m[3]} has no export '${name}'`);
    }
  }
  assert.deepEqual(problems, []);
});
