import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { httpFixture } from '../helpers';

const FILE = 'fixtures/http/http-overflow.json';
async function open(page: Page, file = FILE) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http');
  await page.locator('#file').setInputFiles(file);
}
async function downloadReport(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Expected a local report download');
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('real otelhttp export: HTTP 5xx bounds, panels and report', async ({ page, baseURL }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== baseURL && !r.url().startsWith('blob:')) external.push(r.url());
  });
  await open(page);
  await expect(page.getByTestId('criterion')).toContainText('HTTP 5xx');
  await expect(page.getByTestId('selection')).toContainText('http.server.request.duration');
  await expect(page.getByTestId('selection')).toContainText('DELTA');
  // A matching metric name never confirms the conditions.
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('heading', { name: 'Unsupported input' })).toBeVisible();
  await expect(page.getByText('PROVENANCE_NOT_CONFIRMED')).toBeVisible();
  const contract = page.locator('.contract');
  await expect(contract).toContainText('one completed HTTP request');
  await expect(contract).toContainText('retain the correct http.response.status_code');
  await expect(contract).toContainText('changed neither counts nor attribution');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('≈3.508771% … ≈21.052631%');
  const counts = page.locator('.counts');
  await expect(counts).toContainText('Known requests');
  await expect(counts).toContainText('Known HTTP 5xx');
  await expect(counts).toContainText('SDK overflow');
  for (const [label, value] of [
    ['K', '564'],
    ['E', '24'],
    ['O', '120'],
    ['T', '684'],
  ])
    await expect(
      counts
        .locator('div', { has: page.locator('code', { hasText: new RegExp(`^${label}$`) }) })
        .first(),
    ).toContainText(value);
  await page
    .getByLabel('Maximum HTTP 5xx rate (%)')
    .fill('21.052631578947368421052631578947368421');
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();
  await page.getByLabel('Maximum HTTP 5xx rate (%)').fill('25');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the imported interval' }),
  ).toBeVisible();
  const report = await downloadReport(page);
  const bytes = readFileSync(FILE);
  expect(report).toMatchObject({
    reportVersion: '3',
    mode: 'http-5xx-histogram',
    source: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    inputMetric: { name: 'http.server.request.duration', type: 'Histogram', temporality: 'DELTA' },
    classification: { criterion: 'HTTP 5xx', attribute: 'http.response.status_code' },
    assumptions: { userConfirmed: true },
    result: { status: 'WITHIN_LIMIT', K: '564', E: '24', O: '120', T: '684' },
  });
  expect(report.interval.startTimeUnixNano).toMatch(/^\d+$/);
  expect(report.settings).toEqual({
    intervalId: `${report.interval.startTimeUnixNano}:${report.interval.timeUnixNano}`,
    threshold: '25',
    contractConfirmed: true,
  });
  expect(report.assumptions.conditions).toHaveLength(3);
  expect(external).toEqual([]);
});

test('the bundled example loads in HTTP mode', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http');
  await page.getByRole('button', { name: /Load the HTTP 5xx SDK example/ }).click();
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await expect(page.locator('.counts')).toContainText('684');
});

test('changing the stream, interval, file or mode resets confirmation and result', async ({
  page,
}) => {
  const two = httpFixture([
    { status: 200, count: 3 },
    { status: 500, count: 1 },
  ]);
  const points = two.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
  points.push(
    ...structuredClone(points).map((p) => ({
      ...p,
      startTimeUnixNano: '2000000000',
      timeUnixNano: '3000000000',
    })),
  );
  await open(page, FILE);
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();

  // Another stream of the same file: unavailable, and the previous result is gone.
  const other = page
    .getByLabel('Metric stream')
    .locator('option', { hasText: 'request.body.size' });
  await page.getByLabel('Metric stream').selectOption((await other.getAttribute('value')) ?? '');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);
  await page.getByRole('checkbox').check();
  await expect(page.getByText('UNSUPPORTED_METRIC')).toBeVisible();

  // New file with two intervals: changing the interval clears the confirmation.
  await page.locator('#file').setInputFiles({
    name: 'two.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(two)),
  });
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('25% … 25%');
  await page.getByLabel('Collection interval').selectOption('2000000000:3000000000');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);

  // Replacing the input clears the confirmation too.
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await page.locator('#file').setInputFiles(FILE);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);

  // Leaving the mode discards the import.
  await page.getByRole('checkbox').check();
  await page.getByLabel('Analysis mode').selectOption('delta');
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
});

test('refusals: missing status, corrupt buckets and the Sum modes', async ({ page }) => {
  const missing = httpFixture([{ status: 200 }, { status: null }]);
  const corrupt = httpFixture([{ status: 200, point: { bucketCounts: ['5', '0'], count: '1' } }]);
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http');
  for (const [raw, code] of [
    [missing, 'MISSING_STATUS_CODE'],
    [corrupt, 'BUCKET_COUNT_MISMATCH'],
  ] as const) {
    await page.locator('#file').setInputFiles({
      name: 'case.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(raw)),
    });
    await page.getByRole('checkbox').check();
    await expect(page.getByText(code)).toBeVisible();
    await expect(page.getByTestId('range')).toHaveCount(0);
    const report = await downloadReport(page);
    expect(report.result.diagnostic.code).toBe(code);
    expect(report.result).not.toHaveProperty('K');
  }
  // The same histogram is not a Sum request counter.
  await page.getByLabel('Analysis mode').selectOption('delta');
  await page.locator('#file').setInputFiles(FILE);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByText('UNSUPPORTED_TYPE')).toBeVisible();
});

test('HTTP mode has no horizontal overflow on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await expect(page.getByTestId('selection')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
