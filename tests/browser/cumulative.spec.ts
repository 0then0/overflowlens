import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { largeCumulativeWindow } from '../helpers';

const beforePath = 'fixtures/sdk/cumulative-before.json';
const afterPath = 'fixtures/sdk/cumulative-after.json';
async function imports(page: Page, reverse = false) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  if (reverse) {
    await page.locator('#after-file').setInputFiles(afterPath);
    await expect(page.getByLabel('After metric stream')).not.toHaveValue('');
  }
  await page.locator('#file').setInputFiles(beforePath);
  await expect(page.getByLabel('Before metric stream')).not.toHaveValue('');
  if (!reverse) await page.locator('#after-file').setInputFiles(afterPath);
  await expect(page.getByLabel('After metric stream')).not.toHaveValue('');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
}
async function confirm(page: Page) {
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
}
async function report(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Missing local download');
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('two real SDK imports, applicability, exact window, provenance, bounds and evidence export stay local', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('blob:'))
      external.push(r.url());
  });
  await imports(page);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('range')).toHaveCount(0);
  await confirm(page);
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();
  await page.getByLabel('Maximum error rate (%)', { exact: true }).fill('10');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the cumulative window' }),
  ).toBeVisible();
  const r = await report(page);
  expect(r.reportVersion).toBe('2');
  expect(r.result.T).toBe('1000');
  expect(r.result.E).toBe('1');
  expect(r.result.O).toBe('99');
  for (const [side, path] of [
    ['before', beforePath],
    ['after', afterPath],
  ] as const) {
    expect(r.sources[side].sha256).toBe(
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
    expect(r.sources[side].bytes).toBe(readFileSync(path).length);
  }
  expect(r.window.startTimeUnixNano).toBe(
    await page.getByLabel('Before collection timestamp').inputValue(),
  );
  expect(r.window.timeUnixNano).toBe(
    await page.getByLabel('After collection timestamp').inputValue(),
  );
  expect(r.applicability.status).toBe('APPLICABLE');
  expect(r.assumptions.userConfirmed).toBe(true);
  expect(
    r.result.points.reduce(
      (n: bigint, p: { beforeCount: string }) => n + BigInt(p.beforeCount),
      0n,
    ),
  ).toBe(112n);
  expect(external).toEqual([]);
  await page.screenshot({ path: 'test-results/cumulative-desktop.png', fullPage: true });
});

test('after may be imported first and the View produces an exact window rate', async ({ page }) => {
  await imports(page, true);
  await confirm(page);
  await page.locator('#file').setInputFiles('fixtures/sdk/cumulative-view-before.json');
  await page.locator('#after-file').setInputFiles('fixtures/sdk/cumulative-view-after.json');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('3.4% … 3.4%');
});

test('changing either stream or snapshot, outcome, error value, file or mode revokes provenance and the old verdict', async ({
  page,
}) => {
  await imports(page);
  await confirm(page);
  const oldBefore = await page.getByLabel('Before metric stream').inputValue();
  const oldAfter = await page.getByLabel('After metric stream').inputValue();
  const beforeTime = await page.getByLabel('Before collection timestamp').inputValue();
  const afterTime = await page.getByLabel('After collection timestamp').inputValue();
  const resetCheck = async () => {
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await expect(page.getByTestId('range')).toHaveCount(0);
  };
  await page.getByLabel('Error value').selectOption('true');
  await resetCheck();
  await page.getByLabel('Error value').selectOption('false');
  await confirm(page);
  await page.getByLabel('Boolean outcome attribute').fill('other');
  await resetCheck();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.getByLabel('After collection timestamp').selectOption('');
  await resetCheck();
  await page.getByLabel('After collection timestamp').selectOption(afterTime);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.getByLabel('Before collection timestamp').selectOption('');
  await resetCheck();
  await expect(page.getByLabel('After collection timestamp')).toHaveValue('');
  await page.getByLabel('Before collection timestamp').selectOption(beforeTime);
  await page.getByLabel('After collection timestamp').selectOption(afterTime);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.getByLabel('After metric stream').selectOption('');
  await resetCheck();
  await page.getByLabel('After metric stream').selectOption(oldAfter);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.getByLabel('Before metric stream').selectOption('');
  await resetCheck();
  await expect(page.getByLabel('After metric stream')).toHaveValue('');
  await page.getByLabel('Before metric stream').selectOption(oldBefore);
  await page.getByLabel('After metric stream').selectOption(oldAfter);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.locator('#after-file').setInputFiles(afterPath);
  await resetCheck();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.locator('#file').setInputFiles(beforePath);
  await resetCheck();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  await page.getByLabel('Analysis mode').selectOption('delta');
  await resetCheck();
  await expect(page.getByLabel('Boolean outcome attribute')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Export explanatory JSON/ })).toBeDisabled();
});

test('real restart refuses with both source hashes and no invented counts', async ({ page }) => {
  await imports(page);
  await confirm(page);
  await page.locator('#after-file').setInputFiles('fixtures/sdk/cumulative-restart.json');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await expect(page.getByTestId('applicability')).toContainText('CHANGED_START_TIME');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveCount(0);
  const r = await report(page);
  expect(r.result.diagnostic.code).toBe('CHANGED_START_TIME');
  expect(r.result.T).toBeUndefined();
  expect(r.witnesses).toBeNull();
  expect(r.sources.before.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.sources.after.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test('invalid replacement and oversize after file cannot leave the old verdict visible', async ({
  page,
}) => {
  await imports(page);
  await confirm(page);
  await page.locator('#after-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(page.getByRole('alert')).toContainText('Invalid input');
  await expect(page.getByTestId('range')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.locator('#after-file').setInputFiles({
    name: 'oversize.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, ' '),
  });
  await expect(page.getByRole('alert')).toContainText('FILE_TOO_LARGE');
  await expect(page.getByTestId('range')).toHaveCount(0);
});

test('zero window has no rate and hashes cover original UTF-8 bytes including BOM', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(afterPath)]);
  await page
    .locator('#file')
    .setInputFiles({ name: 'before-bom.json', mimeType: 'application/json', buffer: original });
  await page.locator('#after-file').setInputFiles('fixtures/sdk/cumulative-zero.json');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('heading', { name: 'No observations' })).toBeVisible();
  await expect(page.getByTestId('range')).toHaveCount(0);
  const r = await report(page);
  expect(r.result.T).toBe('0');
  expect(r.result.lower).toBeNull();
  expect(r.witnesses).toBeNull();
  expect(r.sources.before.sha256).toBe(createHash('sha256').update(original).digest('hex'));
  expect(r.sources.before.bytes).toBe(original.length);
});

test('replacing a pending Worker import and switching modes ignores stale data', async ({
  page,
}) => {
  await imports(page);
  // Extend actual SDK JSON with ignored data to keep parsing active during replacement.
  const large = Buffer.from(
    readFileSync(afterPath, 'utf8').replace('{', `{"ignored":"${'x'.repeat(4 * 1024 * 1024)}",`),
  );
  await page
    .locator('#after-file')
    .setInputFiles({ name: 'pending.json', mimeType: 'application/json', buffer: large });
  await page.locator('#after-file').setInputFiles(afterPath);
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  expect((await report(page)).sources.after.name).toBe('cumulative-after.json');
  await page
    .locator('#file')
    .setInputFiles({ name: 'pending-before.json', mimeType: 'application/json', buffer: large });
  await page.getByLabel('Analysis mode').selectOption('delta');
  await page.getByRole('button', { name: /Load the 900/ }).click();
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  expect((await report(page)).reportVersion).toBe('1');
});

test('cumulative mobile layout stays usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await imports(page);
  await confirm(page);
  await expect(page.getByTestId('applicability')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/cumulative-mobile.png', fullPage: true });
});

test('simultaneous before and after imports select the current boundaries', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  await page.evaluate(
    ({ before, after }) => {
      for (const [id, text] of [
        ['file', before],
        ['after-file', after],
      ]) {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement)) throw new Error('Missing importer');
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], `${id}.json`, { type: 'application/json' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    { before: readFileSync(beforePath, 'utf8'), after: readFileSync(afterPath, 'utf8') },
  );
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await confirm(page);
  const r = await report(page);
  expect(r.sources.before.name).toBe('file.json');
  expect(r.sources.after.name).toBe('after-file.json');
  expect(r.result.T).toBe('1000');
});

test('large complete windows update exact thresholds without long tasks or stale evidence', async ({
  page,
}) => {
  const window = largeCumulativeWindow();
  const before = Buffer.from(window.before),
    after = Buffer.from(window.after);
  expect(before.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(after.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  await page
    .locator('#file')
    .setInputFiles({ name: 'large-before.json', mimeType: 'application/json', buffer: before });
  await page
    .locator('#after-file')
    .setInputFiles({ name: 'large-after.json', mimeType: 'application/json', buffer: after });
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('range')).toHaveText('1% … 1%');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
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
    await page.getByLabel('Maximum error rate (%)', { exact: true }).fill(threshold);
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
  await cdp.detach();
  const r = await report(page);
  expect(r.result).toMatchObject({
    K: '28000',
    E: '280',
    O: '0',
    T: '28000',
    status: 'WITHIN_LIMIT',
  });
  expect(r.result.points).toHaveLength(28000);
  expect(r.sources.before.sha256).toBe(createHash('sha256').update(before).digest('hex'));
  expect(r.sources.after.sha256).toBe(createHash('sha256').update(after).digest('hex'));
  expect(r.settings.threshold).toBe('1.1');
});
