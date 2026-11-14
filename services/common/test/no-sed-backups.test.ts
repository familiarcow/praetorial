import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Guard: no tracked sed `-i -e` backup (file ending in `-e` with a tracked sibling minus the suffix).
test('no tracked sed backup files (*-e with tracked sibling)', () => {
  const files = execFileSync('git', ['ls-files', '--full-name', ':/'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const set = new Set(files);
  const stray = files.filter((f) => f.endsWith('-e') && set.has(f.slice(0, -2)));
  assert.deepEqual(stray, []);
});
