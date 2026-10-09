import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { fixture } from '../helpers';

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Load the 900/ }).click();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
}
test('complete local scenario, exact verdicts and explanatory export', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('blob:'))
      external.push(r.url());
  });
  await setup(page);
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();
  await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('10');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the imported interval' }),
  ).toBeVisible();
  await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('0.099999999999999999');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Expected a local report download');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  expect(report.result.T).toBe('1000');
  expect(report.result.lower).toEqual({ numerator: '1', denominator: '1000' });
  expect(report.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.settings.contractConfirmed).toBe(true);
  expect(external).toEqual([]);
});
test('changing attributes or file clears prior settings and verdict', async ({ page }) => {
  await setup(page);
  await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('10');
  await page.getByLabel('Boolean outcome attribute').fill('other');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);
  await page.locator('#file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(page.getByRole('alert')).toContainText('Invalid input');
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(page.getByLabel('Boolean outcome attribute')).toHaveValue('');
});
test('real SDK file imports without JSON edits', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles('fixtures/sdk/indeterminate-view.json');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('3.4% … 3.4%');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
});
test('zero counts and Guardian tagging get distinct outcomes', async ({ page }) => {
  await page.goto('/');
  for (const [raw, heading] of [
    [fixture('0', '0', null), 'No observations'],
    [fixture(), 'Unsupported input'],
  ] as const) {
    if (heading === 'Unsupported input')
      raw.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[2].attributes.push({
        key: 'success',
        value: { boolValue: false },
      });
    await page.locator('#file').setInputFiles({
      name: 'case.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(raw)),
    });
    await page.getByLabel('Boolean outcome attribute').fill('success');
    await page.getByRole('checkbox').check();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});
test('unsupported metric does not block supported stream; selection resets', async ({ page }) => {
  const f = fixture();
  const other = structuredClone(f.resourceMetrics[0].scopeMetrics[0].metrics[0]);
  other.name = 'cumulative';
  other.sum.aggregationTemporality = 2;
  f.resourceMetrics[0].scopeMetrics[0].metrics.push(other);
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'mixed.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(f)),
  });
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await page
    .getByLabel('Metric stream')
    .selectOption({ label: '2. cumulative · test · sum · CUMULATIVE · unavailable' });
  await expect(page.getByRole('heading', { name: 'Unsupported input' })).toBeVisible();
  await expect(page.getByLabel('Boolean outcome attribute')).toHaveValue('');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
});
test('size limit reports actionable diagnostic', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32),
  });
  await expect(page.getByRole('alert')).toContainText('FILE_TOO_LARGE');
});
test('mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByTestId('range')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
test('numeric int64 input survives Worker transfer and exports exactly', async ({ page }) => {
  const raw = JSON.stringify(fixture('9007199254740993', 1, 1)).replace(
    '"9007199254740993"',
    '9007199254740993',
  );
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'numeric.json',
    mimeType: 'application/json',
    buffer: Buffer.from(raw),
  });
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('0');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the imported interval' }),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Expected a local report download');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  expect(report.result.T).toBe('9007199254740995');
  expect(report.result.lower.numerator).toBe('1');
});
test('interval changes require new outcome and provenance', async ({ page }) => {
  const f = fixture();
  const points = f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
  const next = structuredClone(points);
  for (const p of next) {
    p.startTimeUnixNano = '2000000000';
    p.timeUnixNano = '3000000000';
    p.asInt = '0';
  }
  points.push(...next);
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'intervals.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(f)),
  });
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toBeVisible();
  await page.getByLabel('Collection interval').selectOption('2000000000:3000000000');
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByLabel('Boolean outcome attribute')).toHaveValue('');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('heading', { name: 'No observations' })).toBeVisible();
});

test('import validation blocks duplicated bytes, inherited Sum metadata and partial scopes', async ({
  page,
}) => {
  const bytes = fixture('99', '1', null);
  const points = bytes.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
  points[0].attributes.push({ key: 'id', value: { bytesValue: 'YQ==' } });
  const duplicate = structuredClone(points[0]);
  duplicate.attributes[1] = { key: 'id', value: { bytesValue: 'YQ' } };
  points.push(duplicate);

  const inherited = JSON.stringify(fixture('99', '1', null)).replace(
    '"isMonotonic":true,"aggregationTemporality":1,',
    '"__proto__":{"isMonotonic":true,"aggregationTemporality":1},',
  );

  const partial = fixture('99', '1', null);
  const repeat = structuredClone(partial.resourceMetrics[0].scopeMetrics[0]);
  Object.assign(repeat.scope, { droppedAttributesCount: 'bad' });
  repeat.metrics[0].sum.dataPoints.splice(0, 1);
  repeat.metrics[0].sum.dataPoints[0].asInt = '99';
  repeat.metrics[0].sum.dataPoints[0].attributes.push({
    key: 'request.id',
    value: { stringValue: 'second' },
  });
  partial.resourceMetrics[0].scopeMetrics.push(repeat);

  await page.goto('/');
  for (const [raw, heading, code] of [
    [JSON.stringify(bytes), 'Invalid input', 'DUPLICATE_POINT'],
    [inherited, 'Unsupported input', 'UNSUPPORTED_TEMPORALITY'],
    [JSON.stringify(partial), 'Invalid input', 'INVALID_INTEGER'],
  ]) {
    await page.locator('#file').setInputFiles({
      name: 'regression.json',
      mimeType: 'application/json',
      buffer: Buffer.from(raw),
    });
    await page.getByLabel('Boolean outcome attribute').fill('success');
    await page.getByRole('checkbox').check();
    await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('2');
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('.result-panel')).toContainText(code);
    await expect(page.getByTestId('range')).toHaveCount(0);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
    const path = await (await pending).path();
    if (!path) throw new Error('Expected a local report download');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    expect(report.result.diagnostic.code).toBe(code);
    expect(report.result.T).toBeUndefined();
  }
});

test('quoted double dimensions import through Worker and appear in the report', async ({
  page,
}) => {
  const f = fixture('99', '1', null);
  f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({
    key: 'sample.rate',
    value: { doubleValue: '1.25' },
  });
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'quoted-double.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(f)),
  });
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(
    page.getByRole('heading', { name: 'Within limit for the imported interval' }),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Expected a local report download');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  expect(report.result.T).toBe('100');
  expect(report.result.points[0].attributes['sample.rate']).toEqual({ doubleValue: 1.25 });
});
