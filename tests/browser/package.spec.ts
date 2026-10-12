import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve('.');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

test('release archive runs from its documented directory with working assets and Worker', async ({
  page,
}) => {
  const temporary = mkdtempSync(join(tmpdir(), 'overflowlens-package-'));
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const path = resolve(
        temporary,
        'unpacked',
        `overflowlens-${version}`,
        `.${pathname === '/' ? '/index.html' : pathname}`,
      );
      const directory = join(temporary, 'unpacked', `overflowlens-${version}`);
      if (relative(directory, path).startsWith('..')) {
        response.writeHead(403);
        response.end();
        return;
      }
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
      };
      const body = readFileSync(path);
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    const packaged = spawnSync(
      'python3',
      ['scripts/package-release.py', '--output-dir', temporary],
      { cwd: root, encoding: 'utf8' },
    );
    expect(packaged.stderr).toBe('');
    expect(packaged.status).toBe(0);
    const name = `overflowlens-${version}.zip`,
      archive = join(temporary, name);
    expect(readFileSync(join(temporary, 'SHA256SUMS.txt'), 'utf8')).toBe(
      `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${name}\n`,
    );
    const unpacked = spawnSync(
      'python3',
      [
        '-c',
        'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
        archive,
        join(temporary, 'unpacked'),
      ],
      { encoding: 'utf8' },
    );
    expect(unpacked.status).toBe(0);
    const directory = join(temporary, 'unpacked', `overflowlens-${version}`);
    const readme = readFileSync(join(directory, 'README.md'), 'utf8');
    // Follow the launch command embedded in the archive, rather than assuming its layout.
    const launch = /python3 -m http\.server 8080 --bind 127\.0\.0\.1(?: --directory (\S+))?/.exec(
      readme,
    );
    expect(launch).not.toBeNull();
    expect(launch?.[1]).toBeUndefined();
    expect(readFileSync(join(directory, launch?.[1] ?? '.', 'index.html'), 'utf8')).toContain(
      'OverflowLens',
    );
    for (const link of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))
      expect(link[1]).toMatch(/^https:\/\//);
    expect(readFileSync(join(directory, 'LICENSE'), 'utf8')).toContain('Apache License');
    expect(readFileSync(join(directory, 'third-party-notices.txt'), 'utf8')).not.toBe('');
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local archive server');
    const origin = `http://127.0.0.1:${address.port}`;
    const failures: string[] = [],
      external: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(response.url());
    });
    page.on('requestfailed', (request) => failures.push(request.url()));
    page.on('request', (request) => {
      if (!request.url().startsWith(origin) && !request.url().startsWith('blob:'))
        external.push(request.url());
    });
    await page.goto(origin);
    await page.getByRole('button', { name: /Load the 900/ }).click();
    await page.getByLabel('Boolean outcome attribute').fill('success');
    await page.getByRole('checkbox').check();
    await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
    await page.getByLabel('Analysis mode').selectOption('cumulative');
    await page.locator('#file').setInputFiles(join(root, 'fixtures/sdk/cumulative-before.json'));
    await page
      .locator('#after-file')
      .setInputFiles(join(root, 'fixtures/sdk/cumulative-after.json'));
    await page.getByLabel('Boolean outcome attribute').fill('success');
    await page.getByRole('checkbox').check();
    await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
    expect(failures).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await page.close();
    if (server.listening)
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    rmSync(temporary, { recursive: true, force: true });
  }
});
