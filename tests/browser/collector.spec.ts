import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// Browser acceptance for artifacts captured from the pinned OpenTelemetry Collector lab
// (fixtures/collector). It does not start Docker; see docs/collector-validation.md.
const dir = 'fixtures/collector/';
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
  groundTruth: { observations: { success: boolean; count: number }[] };
};
// Ground truth comes from the independently recorded workload, not from any OTLP file.
const truthTotal = manifest.groundTruth.observations.reduce((n, o) => n + BigInt(o.count), 0n);
const truthErrors = manifest.groundTruth.observations.reduce(
  (n, o) => n + (o.success ? 0n : BigInt(o.count)),
  0n,
);
type Fraction = { numerator: string; denominator: string };
const atLeast = (truth: Fraction, bound: Fraction) =>
  BigInt(truth.numerator) * BigInt(bound.denominator) >=
  BigInt(bound.numerator) * BigInt(truth.denominator);
const truth: Fraction = { numerator: truthErrors.toString(), denominator: truthTotal.toString() };

async function load(page: Page, scenario: string, from: string, to: string) {
  await page.goto('/');
  await page.getByLabel('Analysis mode').selectOption('cumulative');
  await page.locator('#file').setInputFiles(`${dir}${scenario}-${from}.json`);
  await expect(page.getByLabel('Before metric stream')).not.toHaveValue('');
  await page.locator('#after-file').setInputFiles(`${dir}${scenario}-${to}.json`);
  await expect(page.getByLabel('After metric stream')).not.toHaveValue('');
  await page.getByLabel('Boolean outcome attribute').fill('success');
  await expect(page.getByTestId('applicability')).toContainText('Pair structurally applicable');
  await page.getByRole('checkbox').check();
}
async function report(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export explanatory JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Missing local download');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const threshold = (page: Page, value: string) =>
  page.getByLabel('Maximum error rate (%)', { exact: true }).fill(value);

test('Collector-produced window excludes the baseline, contains the true 3.4% and decides thresholds', async ({
  page,
}) => {
  await load(page, 'positive', 'before', 'after');
  await expect(page.getByTestId('range')).toHaveText('0.1% … 10%');
  await expect(
    page.getByRole('heading', { name: 'Cannot determine from these data' }),
  ).toBeVisible();
  await threshold(page, '0');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the cumulative window' }),
  ).toBeVisible();
  await threshold(page, '10');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the cumulative window' }),
  ).toBeVisible();
  const r = await report(page);
  expect(r.reportVersion).toBe('2');
  expect(r.identity.temporality).toBe('CUMULATIVE');
  expect([r.result.K, r.result.E, r.result.O, r.result.T]).toEqual(['901', '1', '99', '1000']);
  expect(r.result.T).toBe(truthTotal.toString());
  expect(atLeast(truth, r.result.lower)).toBe(true);
  expect(atLeast(r.result.upper, truth)).toBe(true);
  // The cumulative baseline is excluded: snapshot totals are 112 and 1,112, the window is 1,000.
  const sum = (key: 'beforeCount' | 'afterCount') =>
    r.result.points.reduce((n: bigint, p: Record<string, string>) => n + BigInt(p[key]), 0n);
  expect(sum('beforeCount')).toBe(112n);
  expect(sum('afterCount')).toBe(1112n);
  for (const [side, name] of [
    ['before', 'positive-before.json'],
    ['after', 'positive-after.json'],
  ] as const)
    expect(r.sources[side].sha256).toBe(
      createHash('sha256')
        .update(readFileSync(`${dir}${name}`))
        .digest('hex'),
    );
});

test('zero-increment control from the Collector has no observations', async ({ page }) => {
  await load(page, 'positive', 'after', 'zero');
  await expect(page.getByRole('heading', { name: 'No observations' })).toBeVisible();
  await expect(page.getByTestId('range')).toHaveCount(0);
  expect((await report(page)).result.T).toBe('0');
});

test('overflow dropped downstream is formally valid and exact only for the received counts', async ({
  page,
}) => {
  await load(page, 'drop-overflow', 'before', 'after');
  // Nothing in the data or the application marks the loss: the pair is applicable and exact.
  await expect(page.getByTestId('applicability')).not.toContainText(/refus|unsupported/i);
  await expect(page.getByTestId('range')).toHaveText('≈0.110987% … ≈0.110987%');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the cumulative window' }),
  ).toBeVisible();
  // The assumption the user must confirm is the one this pipeline violated.
  await expect(page.getByText(/downstream transformations/).first()).toBeVisible();
  const r = await report(page);
  expect([r.result.K, r.result.E, r.result.O, r.result.T]).toEqual(['901', '1', '0', '901']);
  expect(r.result.T).not.toBe(truthTotal.toString());
  // The original workload's 3.4% lies outside these bounds: the provenance contract was broken.
  expect(atLeast(r.result.upper, truth)).toBe(false);
  expect(r.assumptions.structurallyProven).toBe(false);
  await threshold(page, '0');
  await expect(
    page.getByRole('heading', { name: 'Exceeds limit for the cumulative window' }),
  ).toBeVisible();
  await threshold(page, '10');
  await expect(
    page.getByRole('heading', { name: 'Within limit for the cumulative window' }),
  ).toBeVisible();
});
