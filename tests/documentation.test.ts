import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

function markdown(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

test('public documentation links resolve within the repository', () => {
  for (const file of ['README.md', 'CONTRIBUTING.md', ...markdown('docs')]) {
    for (const link of readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = link[1].split('#')[0];
      if (!target || /^https?:\/\//.test(target)) continue;
      expect(existsSync(resolve(dirname(file), target)), `${file}: ${target}`).toBe(true);
    }
  }
});

test('packaging without a production build gives an actionable error', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'overflowlens-no-build-'));
  try {
    mkdirSync(join(temporary, 'scripts'));
    writeFileSync(join(temporary, 'package.json'), '{"version":"0.2.0"}');
    const script = join(temporary, 'scripts/package-release.py');
    copyFileSync('scripts/package-release.py', script);
    const result = spawnSync('python3', [script, '--output-dir', join(temporary, 'output')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Build the application first with npm run build.');
    expect(existsSync(join(temporary, 'output'))).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
