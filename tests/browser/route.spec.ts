import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { formatPercent } from '../../src/core/calculate';
import { type RouteSpec, routeFixture } from '../helpers';

const dir = 'fixtures/http';
const FILE = `${dir}/route-overflow.json`;
const manifest = JSON.parse(readFileSync(`${dir}/route-manifest.json`, 'utf8')) as {
  cases: { name: string; K: string; E: string; F: string; S: string; otherRoutesKnown: string }[];
};
const evidence = (name: string) => {
  const c = manifest.cases.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c;
};
const checkbox = (page: Page) => page.getByRole('checkbox');
async function open(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-route');
  await page.locator('#file').setInputFiles(file);
  await expect(page.getByLabel('Metric stream')).not.toHaveValue('');
}
const inline = (raw: unknown) => ({
  name: 'case.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(raw)),
});
async function select(page: Page, route = '/checkout', seconds = '0.5') {
  await page.getByLabel(/^HTTP route/).fill(route);
  await page.getByLabel('Duration threshold').selectOption(seconds);
}
async function report(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Expected a local report download');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const countOf = (page: Page, key: string) =>
  page
    .locator('.counts div', { has: page.locator('code', { hasText: new RegExp(`^${key}$`) }) })
    .first();

test('real SDK export: selection, bounds, counts, threshold reuse and the explanatory report', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== baseURL && !r.url().startsWith('blob:')) external.push(r.url());
  });
  const c = evidence('route-overflow');
  const [K, E, F, S] = [c.K, c.E, c.F, c.S].map(BigInt);
  await open(page, FILE);
  // The boundary is chosen from the file's own boundaries, shown in seconds with milliseconds.
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await expect(page.getByLabel('Duration threshold').locator('option')).toHaveText([
    'Select a bucket boundary',
    '0.1 s (100 ms)',
    '0.25 s (250 ms)',
    '0.5 s (500 ms)',
    '1 s (1000 ms)',
    '2.5 s (2500 ms)',
  ]);
  await page.getByLabel('Duration threshold').selectOption('0.5');
  // Matching names and structure never confirm the conditions.
  await expect(checkbox(page)).not.toBeChecked();
  await expect(page.getByText('PROVENANCE_NOT_CONFIRMED')).toBeVisible();
  const contract = page.locator('.contract');
  for (const text of [
    'complete delta export',
    'one completed HTTP request with its correct duration',
    'retains the correct http.route',
    'genuine SDK overflow semantics',
    'neither counts, buckets nor attribution',
  ])
    await expect(contract).toContainText(text);
  await checkbox(page).check();

  const lower = { numerator: E, denominator: K + F };
  const upper = { numerator: E + S, denominator: K + S };
  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent(lower)} … ${formatPercent(upper)}`,
  );
  for (const [key, value] of [
    ['K', c.K],
    ['E', c.E],
    ['F', c.F],
    ['S', c.S],
  ])
    await expect(countOf(page, key)).toContainText(value);
  await expect(page.getByTestId('slow-definition')).toContainText('exactly 0.5 s is not slow');
  await expect(page.getByTestId('unknown-attribution')).toContainText('http.route');
  // The default 1% maximum lies below the lower bound.
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
  await page.getByLabel('Maximum share of slow requests (%)').fill('5');
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();

  // A maximum share only changes the verdict and keeps the confirmation and counts.
  await page.getByLabel('Maximum share of slow requests (%)').fill('10');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the imported interval' }),
  ).toBeVisible();
  await expect(checkbox(page)).toBeChecked();
  await expect(countOf(page, 'K')).toContainText(c.K);
  await page.getByLabel('Maximum share of slow requests (%)').fill('1.5');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
  await page.getByLabel('Maximum share of slow requests (%)').fill('5');

  const r = await report(page);
  const bytes = readFileSync(FILE);
  expect(r).toMatchObject({
    reportVersion: '5',
    mode: 'http-route-slow-share-histogram',
    source: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    inputMetric: { name: 'http.server.request.duration', unit: 's', temporality: 'DELTA' },
    selection: {
      route: { attribute: 'http.route', value: '/checkout' },
      durationThreshold: { seconds: '0.5', unit: 's' },
    },
    assumptions: { userConfirmed: true },
    counts: { K: c.K, E: c.E, F: c.F, S: c.S, otherRoutesKnown: c.otherRoutesKnown },
    result: {
      status: 'INDETERMINATE',
      lower: { numerator: E.toString(), denominator: (K + F).toString() },
      upper: { numerator: (E + S).toString(), denominator: (K + S).toString() },
    },
  });
  expect(r.settings).toEqual({
    intervalId: `${r.interval.startTimeUnixNano}:${r.interval.timeUnixNano}`,
    route: '/checkout',
    durationSeconds: '0.5',
    maxSlowPercent: '5',
    contractConfirmed: true,
  });
  expect(r.unknownAttribution.explanation).toContain('http.route');
  expect(external).toEqual([]);
});

test('the bundled example loads with its route and boundary selected', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-route');
  await page.getByRole('button', { name: /Load the route slow-share SDK example/ }).click();
  await expect(page.getByLabel(/^HTTP route/)).toHaveValue('/checkout');
  await expect(page.getByLabel('Duration threshold')).toHaveValue('0.5');
  await expect(checkbox(page)).not.toBeChecked();
  await checkbox(page).check();
  await expect(page.getByTestId('range')).toBeVisible();
});

test('changing the stream, interval, file, route, boundary or mode resets the result and confirmation', async ({
  page,
}) => {
  const point = (start: string, end: string): RouteSpec[] =>
    [
      { route: '/checkout', buckets: [8, 0, 2, 0] },
      { overflow: true, buckets: [3, 0, 1, 0] },
    ].map((spec) => ({ ...spec, point: { startTimeUnixNano: start, timeUnixNano: end } }));
  const raw = routeFixture(point('1000000000', '2000000000'));
  const metric = raw.resourceMetrics[0].scopeMetrics[0].metrics[0];
  metric.histogram.dataPoints.push(
    ...routeFixture(point('2000000000', '3000000000')).resourceMetrics[0].scopeMetrics[0].metrics[0]
      .histogram.dataPoints,
  );
  // A second stream of the same file.
  raw.resourceMetrics[0].scopeMetrics[0].metrics.push({
    ...structuredClone(metric),
    name: 'http.server.request.body.size',
  });
  const confirmed = async () => {
    await select(page);
    await checkbox(page).check();
    await expect(page.getByTestId('range')).toBeVisible();
  };
  const cleared = async () => {
    await expect(checkbox(page)).not.toBeChecked();
    await expect(page.getByTestId('range')).toHaveCount(0);
  };
  await open(page, inline(raw));
  await page.getByLabel('Collection interval').selectOption('1000000000:2000000000');
  await confirmed();
  // K=10, E=2, F=3, S=1.
  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent({ numerator: 2n, denominator: 13n })} … ${formatPercent({ numerator: 3n, denominator: 11n })}`,
  );

  // Another route: both the boundary and the confirmation are gone.
  await page.getByLabel(/^HTTP route/).fill('/checkout2');
  await cleared();
  await expect(page.getByLabel('Duration threshold')).toHaveValue('');

  // Another boundary of the same route.
  await confirmed();
  await page.getByLabel('Duration threshold').selectOption('1');
  await cleared();

  // Another interval.
  await confirmed();
  await page.getByLabel('Collection interval').selectOption('2000000000:3000000000');
  await cleared();
  await expect(page.getByLabel(/^HTTP route/)).toHaveValue('');

  // A replaced file.
  await confirmed();
  await page.locator('#file').setInputFiles(FILE);
  await cleared();
  await expect(page.getByLabel(/^HTTP route/)).toHaveValue('');

  // Another stream of the same file is unavailable and starts clean.
  await confirmed();
  await page.getByLabel('Metric stream').selectOption({ index: 1 });
  await cleared();

  // Leaving the mode discards the import.
  await page.locator('#file').setInputFiles(inline(raw));
  await confirmed();
  await page.getByLabel('Analysis mode').selectOption('http');
  await cleared();
  await page.getByLabel('Analysis mode').selectOption('http-route');
  await expect(page.getByLabel(/^HTTP route/)).toHaveValue('');
});

test('a route without ordinary observations gets no share and no verdict', async ({ page }) => {
  const c = evidence('route-absent');
  await open(page, `${dir}/route-absent.json`);
  await select(page);
  await checkbox(page).check();
  await expect(page.getByTestId('no-route-observations')).toContainText('no confirmed request');
  await expect(page.getByTestId('no-route-observations')).toContainText(
    'nothing in the export shows',
  );
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'No confirmed observations of this route' }),
  ).toBeVisible();
  for (const verdict of ['Within limit', 'Exceeds limit', 'Cannot determine'])
    await expect(page.getByRole('heading', { name: new RegExp(verdict) })).toHaveCount(0);
  await expect(countOf(page, 'K')).toContainText('0');
  await expect(countOf(page, 'F')).toContainText(c.F);
  const r = await report(page);
  expect(r.result.status).toBe('NO_ROUTE_OBSERVATIONS');
  expect(r.result.lower).toBeNull();
  expect(r.result.upper).toBeNull();
  expect(r.witnesses).toBeNull();
});

test('refusals: unit, missing route, inconsistent buckets and an unmatched boundary', async ({
  page,
}) => {
  const cases: [string, ReturnType<typeof routeFixture>, string][] = [
    [
      'unit',
      routeFixture([{ route: '/checkout', buckets: [1, 0, 0, 0] }], { unit: 'ms' }),
      'UNSUPPORTED_UNIT',
    ],
    [
      'route',
      routeFixture([
        { route: '/checkout', buckets: [1, 0, 0, 0] },
        { route: null, buckets: [1, 0, 0, 0] },
      ]),
      'MISSING_ROUTE',
    ],
    [
      'buckets',
      routeFixture([
        { route: '/checkout', buckets: [1, 0, 0, 0] },
        { overflow: true, buckets: [1, 0, 0, 0], count: 5 },
      ]),
      'BUCKET_COUNT_MISMATCH',
    ],
  ];
  for (const [, raw, code] of cases) {
    await open(page, inline(raw));
    await select(page);
    await checkbox(page).check();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    await expect(page.getByTestId('range')).toHaveCount(0);
    const r = await report(page);
    expect(r.result.diagnostic.code).toBe(code);
    expect(r.counts).toBeNull();
  }
  // Overflow bounds without the chosen boundary: nothing matching is offered, and nothing is rounded.
  await open(
    page,
    inline(
      routeFixture([
        { route: '/checkout', buckets: [1, 0, 0, 0] },
        { overflow: true, buckets: [1, 0, 0, 0], bounds: [0.2, 0.7, 2] },
      ]),
    ),
  );
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await expect(page.getByLabel('Duration threshold').locator('option')).toHaveText([
    'Select a bucket boundary',
  ]);
  await expect(page.getByTestId('no-boundary')).toContainText(
    'no duration threshold can be offered',
  );
  await checkbox(page).check();
  await expect(page.getByText('DURATION_NOT_SELECTED')).toBeVisible();
  await expect(page.getByTestId('range')).toHaveCount(0);
});

test('the HTTP 5xx mode does not accept a histogram without status codes', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http');
  await page.locator('#file').setInputFiles(FILE);
  await checkbox(page).check();
  // The delta HTTP 5xx mode needs status codes, which this histogram does not have.
  await expect(page.getByText('MISSING_STATUS_CODE')).toBeVisible();
});

test('route mode has no horizontal overflow on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, FILE);
  await select(page);
  await checkbox(page).check();
  await expect(page.getByTestId('range')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
