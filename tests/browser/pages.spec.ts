import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// Serve the actual production build at the Pages project path; no SPA fallback can
// hide accidental requests to domain-root assets or missing Worker files.
const root = resolve('dist');
const prefix = '/overflowlens/';
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/overflowlens') {
    response.writeHead(301, { Location: prefix });
    response.end();
    return;
  }
  try {
    if (!pathname.startsWith(prefix)) throw new Error('Outside project path');
    const path = resolve(
      root,
      pathname === prefix ? 'index.html' : decodeURIComponent(pathname.slice(prefix.length)),
    );
    if (relative(root, path).startsWith('..')) throw new Error('Outside build');
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.txt': 'text/plain',
    };
    const body = readFileSync(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
let origin = '';
test.beforeAll(async () => {
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Pages test server');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
});

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [1440, 375]) {
    test(`Pages production distribution: ${colorScheme}, ${width}px, local examples/import/export`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const requests: { url: string; method: string; type: string }[] = [];
      const failures: string[] = [];
      context.on('request', (request) =>
        requests.push({
          url: request.url(),
          method: request.method(),
          type: request.resourceType(),
        }),
      );
      context.on('response', (response) => {
        if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
      });
      context.on('requestfailed', (request) => failures.push(request.url()));
      page.on('pageerror', (error) => failures.push(error.message));
      // Observe API attempts too, including values passed to APIs that could send
      // data even if no request completes. Worker traffic is captured by context.
      await context.addInitScript(() => {
        const calls: string[] = [];
        Object.defineProperty(window, '__outbound', { value: calls });
        for (const [target, name] of [
          [window, 'fetch'],
          [XMLHttpRequest.prototype, 'open'],
          [navigator, 'sendBeacon'],
        ] as const) {
          Object.defineProperty(target, name, {
            configurable: true,
            value: new Proxy(Reflect.get(target, name), {
              apply(fn, receiver, args) {
                calls.push(name);
                return Reflect.apply(fn, receiver, args);
              },
            }),
          });
        }
        window.WebSocket = new Proxy(window.WebSocket, {
          construct(fn, args) {
            calls.push('WebSocket');
            return Reflect.construct(fn, args);
          },
        });
      });
      await page.goto(`${origin}/overflowlens`);
      await expect(page).toHaveURL(`${origin}${prefix}`);
      await expect(page.locator('.version')).toHaveText(`v${version}`);
      await expect(
        page.getByText(/Imported files and reports are processed locally/),
      ).toBeVisible();
      // CSS follows the system media query, rather than pinning one color scheme.
      const background = await page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).toBe(colorScheme === 'dark' ? 'rgb(4, 4, 11)' : 'rgb(245, 245, 243)');
      await page.reload();
      await page.waitForLoadState('networkidle');
      const afterLoad = requests.length;
      await page.getByRole('button', { name: /Load the 900/ }).click();
      await page.getByRole('checkbox').check();
      await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
      await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('10');
      await expect(
        page.getByRole('heading', { name: 'Within limit for the imported interval' }),
      ).toBeVisible();
      const deltaDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
      const deltaPath = await (await deltaDownload).path();
      if (!deltaPath) throw new Error('Missing delta report');
      expect(JSON.parse(readFileSync(deltaPath, 'utf8')).result.T).toBe('1000');

      await page.getByLabel('Analysis mode').selectOption('cumulative');
      await page.getByRole('button', { name: /Load the cumulative before/ }).click();
      await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
      await expect(page.getByRole('checkbox')).not.toBeChecked();
      await expect(page.getByTestId('range')).toHaveCount(0);
      await page.getByRole('checkbox').check();
      await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
      await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('0');
      await expect(
        page.getByRole('heading', { name: 'Exceeds limit for the cumulative window' }),
      ).toBeVisible();
      await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('10');
      await expect(
        page.getByRole('heading', { name: 'Within limit for the cumulative window' }),
      ).toBeVisible();
      const cumulativeDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
      const cumulativePath = await (await cumulativeDownload).path();
      if (!cumulativePath) throw new Error('Missing cumulative report');
      const report = JSON.parse(readFileSync(cumulativePath, 'utf8'));
      expect(report.application.version).toBe(version);
      expect([report.result.K, report.result.E, report.result.O, report.result.T]).toEqual([
        '901',
        '1',
        '99',
        '1000',
      ]);
      // Independent synthetic SDK ground truth, including the excluded baseline.
      const manifest = JSON.parse(readFileSync('fixtures/sdk/manifest.json', 'utf8'));
      const scenario = manifest.cumulativeCases.find(
        (s: { name: string }) => s.name === 'cumulative',
      );
      expect(scenario.truthErrors).toBe('34');
      expect(scenario.truthTotal).toBe('1000');
      expect(
        report.result.points.reduce(
          (n: bigint, p: { beforeCount: string }) => n + BigInt(p.beforeCount),
          0n,
        ),
      ).toBe(BigInt(scenario.baselineTotal));
      for (const side of ['before', 'after'] as const)
        expect(report.sources[side].sha256).toBe(
          createHash('sha256')
            .update(readFileSync(`fixtures/sdk/cumulative-${side}.json`))
            .digest('hex'),
        );

      await page.screenshot({
        path: `test-results/pages-${colorScheme}-${width}-example.png`,
        fullPage: true,
      });

      // User-supplied file takes the same Worker path. Include a unique local
      // filename/value so any transmission would appear in intercepted traffic.
      await page.getByLabel('Analysis mode').selectOption('delta');
      await page.locator('#file').setInputFiles({
        name: 'private-local-fixture.json',
        mimeType: 'application/json',
        buffer: readFileSync('public/examples/no-overflow.json'),
      });
      await expect(page.getByLabel('Metric stream')).not.toHaveValue('');
      await page.getByLabel('Boolean outcome attribute').fill('private-local-value');
      await page.getByLabel('Boolean outcome attribute').fill('success');
      await page.getByRole('checkbox').check();
      await expect(page.getByTestId('range')).toBeVisible();
      await page.locator('#file').setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{'),
      });
      await expect(page.getByRole('alert')).toContainText('Invalid input');
      await expect(page.getByTestId('range')).toHaveCount(0);
      expect(await page.evaluate(() => Reflect.get(window, '__outbound'))).toEqual([]);
      expect(await page.locator('html').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({
        path: `test-results/pages-${colorScheme}-${width}.png`,
        fullPage: true,
      });
      expect(failures).toEqual([]);
      for (const request of requests) {
        const url = new URL(request.url);
        expect(url.origin).toBe(origin);
        expect(url.pathname, request.url).toMatch(/^\/overflowlens(?:\/|$)/);
        expect(url.search).toBe('');
        expect(request.method).toBe('GET');
        expect(['fetch', 'xhr', 'websocket', 'ping']).not.toContain(request.type);
      }
      // Analysis may lazily download its own Worker; no file bytes, reports or
      // entered settings may be sent even to a same-origin endpoint.
      const analysisRequests = requests.slice(afterLoad);
      expect(analysisRequests.length).toBeGreaterThan(0);
      expect(
        analysisRequests.filter(
          (r) => !/\/assets\/import\.worker-[^/]+\.js$/.test(new URL(r.url).pathname),
        ),
      ).toEqual([]);
      expect(
        requests.some((r) => /\/assets\/import\.worker-[^/]+\.js$/.test(new URL(r.url).pathname)),
      ).toBe(true);
    });
  }
}
