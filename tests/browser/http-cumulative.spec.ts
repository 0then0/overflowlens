import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { formatPercent } from '../../src/core/calculate';
import { largeHttpCumulativeWindow } from '../helpers';

const dir = 'fixtures/http';
type Result = Record<
  'K' | 'E' | 'O' | 'T' | 'truthTotal' | 'truthServerErrors' | 'afterTotal' | 'baselineTotal',
  string
>;
const manifest = JSON.parse(readFileSync(`${dir}/cumulative-manifest.json`, 'utf8')) as {
  result: Result;
};
const BEFORE = `${dir}/http-cumulative-before.json`;
const AFTER = `${dir}/http-cumulative-after.json`;
const lower = { numerator: BigInt(manifest.result.E), denominator: BigInt(manifest.result.T) };
const upper = {
  numerator: BigInt(manifest.result.E) + BigInt(manifest.result.O),
  denominator: BigInt(manifest.result.T),
};

async function select(page: Page, before = BEFORE, after = AFTER) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page.locator('#file').setInputFiles(before);
  await expect(page.getByLabel('Before metric stream')).not.toHaveValue('');
  await page.locator('#after-file').setInputFiles(after);
  await expect(page.getByLabel('After metric stream')).not.toHaveValue('');
}
async function report(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Missing local download');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const countOf = (page: Page, label: string) =>
  page
    .locator('.counts div', { has: page.locator('code', { hasText: new RegExp(`^${label}$`) }) })
    .first();

test('real otelhttp pair: checks, window, counts, threshold reuse and the evidence report', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== baseURL && !r.url().startsWith('blob:')) external.push(r.url());
  });
  await select(page);
  // The pair is checked before anything is confirmed, and nothing is invented.
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
  await expect(page.getByTestId('pair-checks')).toContainText(
    'known unchanged per-series start times',
  );
  await expect(page.getByTestId('pair-checks')).toContainText('unchanged bucket boundaries');
  await expect(page.getByTestId('criterion')).toContainText('HTTP 5xx');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);
  const beforeTime = await page.getByLabel('Before collection timestamp').inputValue();
  const afterTime = await page.getByLabel('After collection timestamp').inputValue();
  await expect(page.getByTestId('window')).toContainText(`(${beforeTime}, ${afterTime}] ns`);
  const contract = page.locator('.contract');
  await expect(contract).toContainText('one continuous source history');
  await expect(contract).toContainText('retain the correct http.response.status_code');
  await expect(contract).toContainText('changed neither counts nor attribution');

  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText(
    `${formatPercent(lower)} … ${formatPercent(upper)}`,
  );
  for (const key of ['K', 'E', 'O', 'T'] as const)
    await expect(countOf(page, key)).toContainText(manifest.result[key]);
  await expect(page.getByTestId('boundary-counts')).toContainText(
    `${manifest.result.baselineTotal} before → ${manifest.result.afterTotal} after`,
  );
  // A threshold change keeps the confirmation and the counts; the verdict follows the exact value.
  for (const [threshold, heading] of [
    ['3', 'Exceeds limit for the cumulative window'],
    ['10', 'Cannot determine from these data'],
    ['25', 'Within limit for the cumulative window'],
  ]) {
    await page.getByLabel('Maximum HTTP 5xx rate (%)').fill(threshold);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await expect(page.getByTestId('pair-checks')).toBeVisible();
    await expect(countOf(page, 'T')).toContainText(manifest.result.T);
  }

  const r = await report(page);
  expect(r).toMatchObject({
    reportVersion: '4',
    mode: 'http-5xx-histogram-cumulative',
    window: { startTimeUnixNano: beforeTime, timeUnixNano: afterTime },
    settings: {
      beforeSnapshotId: beforeTime,
      afterSnapshotId: afterTime,
      threshold: '25',
      contractConfirmed: true,
    },
    assumptions: { userConfirmed: true, structurallyProven: false },
    applicability: { status: 'APPLICABLE' },
    result: {
      status: 'WITHIN_LIMIT',
      K: manifest.result.K,
      E: manifest.result.E,
      O: manifest.result.O,
      T: manifest.result.T,
    },
  });
  for (const [side, path] of [
    ['before', BEFORE],
    ['after', AFTER],
  ] as const) {
    expect(r.sources[side].sha256).toBe(sha(path));
    expect(r.sources[side].bytes).toBe(readFileSync(path).length);
  }
  expect(r.counts.atBeforeBoundary.total).toBe(manifest.result.baselineTotal);
  expect(r.counts.atAfterBoundary.total).toBe(manifest.result.afterTotal);
  expect(r.counts.window.total).toBe(manifest.result.T);
  // The independently tallied true share lies inside the exported exact bounds.
  const frac = (f: { numerator: string; denominator: string }) => [
    BigInt(f.numerator),
    BigInt(f.denominator),
  ];
  const [ln, ld] = frac(r.result.lower),
    [un, ud] = frac(r.result.upper);
  const tn = BigInt(manifest.result.truthServerErrors),
    td = BigInt(manifest.result.truthTotal);
  expect(tn * ld).toBeGreaterThanOrEqual(ln * td);
  expect(tn * ud).toBeLessThanOrEqual(un * td);
  expect(r.witnesses.upper.overflowServerErrors).toBe(manifest.result.O);
  expect(external).toEqual([]);
  await page.screenshot({ path: 'test-results/http-cumulative-desktop.png', fullPage: true });
});

test('after may be imported first', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page.locator('#after-file').setInputFiles(AFTER);
  await expect(page.getByLabel('After metric stream')).not.toHaveValue('');
  await page.locator('#file').setInputFiles(BEFORE);
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
  await page.getByRole('checkbox').check();
  await expect(countOf(page, 'T')).toContainText(manifest.result.T);
});

test('changing the input, stream, boundary or mode revokes confirmation and the result', async ({
  page,
}) => {
  await select(page);
  const confirm = async () => {
    await page.getByRole('checkbox').check();
    await expect(page.getByTestId('range')).toBeVisible();
  };
  const revoked = async () => {
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await expect(page.getByTestId('range')).toHaveCount(0);
  };
  const oldBefore = await page.getByLabel('Before metric stream').inputValue();
  const oldAfter = await page.getByLabel('After metric stream').inputValue();
  const beforeTime = await page.getByLabel('Before collection timestamp').inputValue();
  const afterTime = await page.getByLabel('After collection timestamp').inputValue();

  await confirm();
  await page.getByLabel('After collection timestamp').selectOption('');
  await revoked();
  await page.getByLabel('After collection timestamp').selectOption(afterTime);
  await confirm();
  await page.getByLabel('Before collection timestamp').selectOption('');
  await revoked();
  await page.getByLabel('Before collection timestamp').selectOption(beforeTime);
  await page.getByLabel('After collection timestamp').selectOption(afterTime);
  await confirm();
  await page.getByLabel('After metric stream').selectOption('');
  await revoked();
  await page.getByLabel('After metric stream').selectOption(oldAfter);
  await confirm();
  await page.getByLabel('Before metric stream').selectOption('');
  await revoked();
  await expect(page.getByLabel('After metric stream')).toHaveValue('');
  await page.getByLabel('Before metric stream').selectOption(oldBefore);
  await page.getByLabel('After metric stream').selectOption(oldAfter);
  await confirm();
  await page.locator('#after-file').setInputFiles(AFTER);
  await revoked();
  await confirm();
  await page.locator('#file').setInputFiles(BEFORE);
  await revoked();
  await confirm();
  await page.getByLabel('Analysis mode').selectOption('http');
  await revoked();
  await expect(page.getByRole('button', { name: /Export explanatory JSON/ })).toBeDisabled();
});

test('a real SDK restart is refused with both hashes and no invented counts', async ({ page }) => {
  const restart = `${dir}/http-cumulative-restart.json`;
  await select(page, BEFORE, restart);
  await expect(page.getByTestId('applicability')).toContainText('CHANGED_START_TIME');
  await expect(page.getByTestId('pair-checks')).toHaveCount(0);
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(page.getByText('CHANGED_START_TIME').first()).toBeVisible();
  const r = await report(page);
  expect(r.result.diagnostic.code).toBe('CHANGED_START_TIME');
  expect(r.result.T).toBeUndefined();
  expect(r.counts).toBeNull();
  expect(r.witnesses).toBeNull();
  expect(r.sources.before.sha256).toBe(sha(BEFORE));
  expect(r.sources.after.sha256).toBe(sha(restart));
});

test('a later collection with no new requests has no rate', async ({ page }) => {
  await select(page, AFTER, `${dir}/http-cumulative-zero.json`);
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('heading', { name: 'No observations' })).toBeVisible();
  await expect(page.getByTestId('range')).toHaveCount(0);
  expect((await report(page)).result).toMatchObject({ T: '0', lower: null, upper: null });
});

test('one corrupt histogram point of a selected stream blocks the pair', async ({ page }) => {
  const raw = JSON.parse(readFileSync(AFTER, 'utf8'));
  const duration = raw.resourceMetrics[0].scopeMetrics[0].metrics.find(
    (m: { name: string }) => m.name === 'http.server.request.duration',
  );
  const last = duration.histogram.dataPoints.at(-1);
  last.bucketCounts[0] = String(BigInt(last.bucketCounts[0]) + 1n);
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page.locator('#file').setInputFiles(BEFORE);
  await page.locator('#after-file').setInputFiles({
    name: 'corrupt-after.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(raw)),
  });
  // The corrupt duration stream stays selected, so the exact refusal is shown.
  await expect(page.getByTestId('applicability')).toContainText('BUCKET_COUNT_MISMATCH');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveCount(0);
  expect((await report(page)).result.diagnostic.code).toBe('BUCKET_COUNT_MISMATCH');
});

test('the bundled example loads, and the delta and Sum modes are unaffected', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page.getByRole('button', { name: /Load the cumulative HTTP 5xx before/ }).click();
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  expect((await report(page)).sources.before.name).toBe(
    'http-cumulative-before.json · SDK example',
  );
  await page.getByLabel('Analysis mode').selectOption('http');
  await page.getByRole('button', { name: /Load the HTTP 5xx SDK example/ }).click();
  await page.getByRole('checkbox').check();
  expect((await report(page)).reportVersion).toBe('3');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  await page.getByRole('button', { name: /Load the cumulative before/ }).click();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  expect((await report(page)).reportVersion).toBe('2');
});

test('size limits still apply and near-limit files still import', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page.locator('#after-file').setInputFiles({
    name: 'oversize.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, ' '),
  });
  await expect(page.getByRole('alert')).toContainText('FILE_TOO_LARGE');
  await page.locator('#file').setInputFiles({
    name: 'oversize.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, ' '),
  });
  await expect(page.getByRole('alert').first()).toContainText('FILE_TOO_LARGE');
  // Files near the limit still import in the Worker and pair.
  const padded = (path: string) =>
    Buffer.from(
      readFileSync(path, 'utf8').replace(
        '{',
        `{"ignored":"${'x'.repeat(5 * 1024 * 1024 - 200_000)}",`,
      ),
    );
  await page
    .locator('#file')
    .setInputFiles({ name: 'a.json', mimeType: 'application/json', buffer: padded(BEFORE) });
  await page
    .locator('#after-file')
    .setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: padded(AFTER) });
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
});

test('large complete windows update exact thresholds without long tasks or stale evidence', async ({
  page,
}) => {
  const window = largeHttpCumulativeWindow();
  const before = Buffer.from(window.before),
    after = Buffer.from(window.after);
  expect(before.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(after.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('http-cumulative');
  await page
    .locator('#file')
    .setInputFiles({ name: 'large-before.json', mimeType: 'application/json', buffer: before });
  await page
    .locator('#after-file')
    .setInputFiles({ name: 'large-after.json', mimeType: 'application/json', buffer: after });
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('1% … 1%');
  await page.evaluate(() => {
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((e) => e.duration)),
    );
    observer.observe({ type: 'longtask', buffered: false });
    Object.assign(globalThis, { thresholdTasks: { longTasks, observer } });
  });
  for (const [threshold, heading] of [
    ['0.9', 'Exceeds limit for the cumulative window'],
    ['1', 'Within limit for the cumulative window'],
    ['1.1', 'Within limit for the cumulative window'],
  ]) {
    await page.getByLabel('Maximum HTTP 5xx rate (%)').fill(threshold);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).toBeChecked();
  }
  const tasks = await page.evaluate(() => {
    const { longTasks, observer } = (
      globalThis as typeof globalThis & {
        thresholdTasks: { longTasks: number[]; observer: PerformanceObserver };
      }
    ).thresholdTasks;
    longTasks.push(...observer.takeRecords().map((e) => e.duration));
    observer.disconnect();
    return longTasks;
  });
  expect(tasks).toEqual([]);
  const r = await report(page);
  expect(r.result).toMatchObject({
    K: '19000',
    E: '190',
    O: '0',
    T: '19000',
    status: 'WITHIN_LIMIT',
  });
  expect(r.result.points).toHaveLength(19000);
  expect(r.sources.before.sha256).toBe(createHash('sha256').update(before).digest('hex'));
  expect(r.settings.threshold).toBe('1.1');
});

test('cumulative HTTP mode has no horizontal overflow on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await select(page);
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await expect(page.getByTestId('pair-checks')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/http-cumulative-mobile.png', fullPage: true });
});
