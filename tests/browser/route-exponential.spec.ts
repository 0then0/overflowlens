import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { compare, formatPercent } from '../../src/core/calculate';
import { normalize } from '../../src/core/normalize';
import { parseOtlp } from '../../src/core/parse';
import { analyzeRouteSlowShare } from '../../src/core/routeSlow';
import { expRouteFixture } from '../helpers';

const dir = 'fixtures/http';
const manifest = JSON.parse(readFileSync(`${dir}/route-exp-manifest.json`, 'utf8')) as {
  cases: {
    name: string;
    file: string;
    truthSelectedRoute: { thresholdSeconds: string; requests: string; slow: string }[];
  }[];
};
const evidence = (name: string) => {
  const c = manifest.cases.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c;
};
const truth = (name: string, threshold: string) => {
  const t = evidence(name).truthSelectedRoute.find((x) => x.thresholdSeconds === threshold);
  if (!t) throw new Error(threshold);
  return { numerator: BigInt(t.slow), denominator: BigInt(t.requests) };
};
// Expected values from the core, for comparison with what the page shows.
const expected = (file: string, durationSeconds: string) => {
  const s = normalize(parseOtlp(readFileSync(file, 'utf8'))).streams[0];
  const r = analyzeRouteSlowShare(s, {
    intervalId: s.intervals[0].id,
    route: '/checkout',
    durationSeconds,
    maxSlowPercent: '10',
    contractConfirmed: true,
  });
  if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
  return { ...r, lower: r.lower, upper: r.upper };
};
const checkbox = (page: Page) => page.getByRole('checkbox');
const thresholdInput = (page: Page) => page.getByLabel('Duration threshold (seconds)');
async function open(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-route');
  await page.locator('#file').setInputFiles(file);
  await expect(page.getByLabel('Metric stream')).not.toHaveValue('');
}
async function report(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Expected a local report download');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const countOf = (page: Page, symbol: string) =>
  page
    .locator('.counts div', { has: page.locator('code', { hasText: new RegExp(`^${symbol}$`) }) })
    .first();

test('real SDK exponential export with overflow: typed threshold, bounds, counts and report', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== baseURL && !r.url().startsWith('blob:')) external.push(r.url());
  });
  const file = `${dir}/route-exp-overflow.json`;
  const e = expected(file, '0.3');
  await open(page, file);
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  // No bucket boundaries are offered; the threshold is typed.
  await expect(page.getByLabel('Duration threshold', { exact: true })).toHaveCount(0);
  await thresholdInput(page).fill('0.3');
  await expect(page.getByTestId('criterion')).toContainText('uncertain');
  await expect(checkbox(page)).not.toBeChecked();
  await expect(page.locator('.contract')).toContainText('ExponentialHistogram');
  await checkbox(page).check();

  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent(e.lower)} … ${formatPercent(e.upper)}`,
  );
  for (const [symbol, value] of [
    ['K', e.K],
    ['L', e.E],
    ['B', e.B],
    ['F', e.F],
    ['S', e.S],
    ['X', e.X],
  ] as const)
    await expect(countOf(page, symbol)).toContainText(value.toString());
  await expect(page.getByTestId('uncertainty-sources')).toContainText(
    `${e.B + e.X} uncertain (B + X)`,
  );
  await expect(page.getByTestId('uncertainty-sources')).toContainText(
    `${e.F + e.S + e.X} uncertain (F + S + X)`,
  );
  await expect(page.getByTestId('threshold-crossing')).toBeVisible();
  await expect(page.getByTestId('unknown-attribution')).toContainText('http.route');
  await expect(page.locator('.method-panel')).toContainText('L / (K + F_max)');
  // The lower bound exceeds 10%, so the default 1% and 10% limits are exceeded.
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
  await page.getByLabel('Maximum share of slow requests (%)').fill('20');
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();

  const r = await report(page);
  const bytes = readFileSync(file);
  expect(r).toMatchObject({
    reportVersion: '6',
    mode: 'http-route-slow-share-exponential-histogram',
    source: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    selection: { durationThreshold: { seconds: '0.3' } },
    assumptions: { userConfirmed: true, overflowMarkerProvesProvenance: false },
    result: { status: 'INDETERMINATE' },
  });
  // The report is checkable on its own: bounds replay from its counts, and the true share
  // computed from the recorded durations lies inside them.
  const c = r.counts;
  const lower = { numerator: BigInt(c.L), denominator: BigInt(c.K) + BigInt(c.F_max) };
  const upper = {
    numerator: BigInt(c.U) + BigInt(c.S_max),
    denominator: BigInt(c.K) + BigInt(c.S_max),
  };
  expect(r.result.lower).toEqual({
    numerator: lower.numerator.toString(),
    denominator: lower.denominator.toString(),
  });
  expect(r.result.upper).toEqual({
    numerator: upper.numerator.toString(),
    denominator: upper.denominator.toString(),
  });
  const t = truth('route-exp-overflow', '0.3');
  expect(compare(t, lower)).toBeGreaterThan(0n);
  expect(compare(t, upper)).toBeLessThan(0n);
  const sum = (key: string) =>
    r.points
      .filter((p: { role: string }) => p.role === 'selected_route')
      .reduce((n: bigint, p: Record<string, string>) => n + BigInt(p[key]), 0n);
  expect(sum('count').toString()).toBe(c.K);
  expect(sum('slow').toString()).toBe(c.L);
  expect(sum('uncertain').toString()).toBe(c.knownUncertain);
  expect(
    r.points.every((p: { exponential?: unknown; role: string }) =>
      ['selected_route', 'overflow'].includes(p.role) ? p.exponential : true,
    ),
  ).toBe(true);
  expect(external).toEqual([]);
});

test('without overflow the threshold inside a bucket still leaves a range; a power of two does not', async ({
  page,
}) => {
  const file = `${dir}/route-exp-no-overflow.json`;
  await open(page, file);
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await thresholdInput(page).fill('0.3');
  await checkbox(page).check();
  const e = expected(file, '0.3');
  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent(e.lower)} … ${formatPercent(e.upper)}`,
  );
  await expect(page.getByTestId('threshold-crossing')).toBeVisible();
  await expect(page.getByTestId('unknown-attribution')).toHaveCount(0);
  // Changing the threshold clears the confirmation.
  await thresholdInput(page).fill('0.5');
  await expect(checkbox(page)).not.toBeChecked();
  await checkbox(page).check();
  const exact = truth('route-exp-no-overflow', '0.5');
  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent(exact)} … ${formatPercent(exact)}`,
  );
  await expect(page.getByTestId('threshold-crossing')).toHaveCount(0);
});

test('negative buckets and an invalid typed threshold are refused', async ({ page }) => {
  const raw = expRouteFixture([
    { route: '/checkout', buckets: [1], negative: { bucketCounts: [1] } },
  ]);
  await open(page, {
    name: 'negative.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(raw)),
  });
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await thresholdInput(page).fill('0.3');
  await checkbox(page).check();
  await expect(page.getByText('NEGATIVE_DURATIONS', { exact: true })).toBeVisible();
  await expect(page.getByTestId('range')).toHaveCount(0);
  const r = await report(page);
  expect(r.reportVersion).toBe('6');
  expect(r.counts).toBeNull();
  await open(page, `${dir}/route-exp-overflow.json`);
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await thresholdInput(page).fill('0,3');
  await checkbox(page).check();
  await expect(page.getByText('INVALID_DURATION_THRESHOLD', { exact: true })).toBeVisible();
});

test('exponential route mode has no horizontal overflow on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `${dir}/route-exp-overflow.json`);
  await page.getByLabel(/^HTTP route/).fill('/checkout');
  await thresholdInput(page).fill('0.3');
  await checkbox(page).check();
  await expect(page.getByTestId('range')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
