import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { analyzeCumulative, type CumulativeSettings } from '../src/core/cumulative';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { run } from './helpers';

const manifest = JSON.parse(
  readFileSync(new URL('../fixtures/sdk/manifest.json', import.meta.url), 'utf8'),
) as {
  cases: {
    file: string;
    thresholdPercent: string;
    expected: string;
    K: string;
    E: string;
    O: string;
    T: string;
    truthTotal: string;
    truthErrors: string;
    view: boolean;
    groundTruth: { success: boolean; count: number }[];
  }[];
};
describe('real Go SDK v1.47.0 exported fixtures', () => {
  for (const c of manifest.cases)
    test(c.file, () => {
      const data = normalize(
        parseOtlp(readFileSync(new URL(`../fixtures/sdk/${c.file}`, import.meta.url), 'utf8')),
      );
      expect(data.diagnostics).toEqual([]);
      expect(data.streams).toHaveLength(1);
      const result = run(data.streams[0], { threshold: c.thresholdPercent });
      expect(result.status).toBe(c.expected);
      if (!('K' in result) || !result.lower || !result.upper)
        throw new Error('SDK fixture rejected');
      for (const key of ['K', 'E', 'O', 'T'] as const) expect(result[key].toString()).toBe(c[key]);
      const total = c.groundTruth.reduce((n, o) => n + BigInt(o.count), 0n),
        errors = c.groundTruth.reduce((n, o) => n + (o.success ? 0n : BigInt(o.count)), 0n);
      expect(total.toString()).toBe(c.truthTotal);
      expect(errors.toString()).toBe(c.truthErrors);
      expect(result.T).toBe(total);
      const truth = { numerator: errors, denominator: total };
      expect(compare(truth, result.lower)).toBeGreaterThanOrEqual(0n);
      expect(compare(truth, result.upper)).toBeLessThanOrEqual(0n);
      if (c.view) {
        expect(result.O).toBe(0n);
        expect(compare(result.lower, result.upper)).toBe(0n);
        expect(result.E).toBe(errors);
      } else expect(result.O).toBeGreaterThan(0n);
    });
});

type CumulativeCase = (typeof manifest.cases)[number] & {
  beforeFile: string;
  afterFile: string;
  zeroFile: string;
  restartFile: string;
  baselineTotal: string;
  baselineOverflow: string;
  baselineGroundTruth: { success: boolean; count: number }[];
};
const cumulativeCases = (
  JSON.parse(readFileSync(new URL('../fixtures/sdk/manifest.json', import.meta.url), 'utf8')) as {
    cumulativeCases: CumulativeCase[];
  }
).cumulativeCases;
function sdkStream(file: string) {
  const data = structuredClone(
    normalize(parseOtlp(readFileSync(new URL(`../fixtures/sdk/${file}`, import.meta.url), 'utf8'))),
  );
  expect(data.diagnostics).toEqual([]);
  expect(data.streams).toHaveLength(1);
  expect(data.streams[0].diagnostics).toEqual([]);
  return data.streams[0];
}
describe('real default-cumulative Go SDK v1.47.0 exports', () => {
  for (const c of cumulativeCases) {
    test(`${c.beforeFile} → ${c.afterFile}: baseline exclusion, conservation and truth containment`, () => {
      const before = sdkStream(c.beforeFile),
        after = sdkStream(c.afterFile);
      expect(before.identity.temporality).toBe('CUMULATIVE');
      const options: CumulativeSettings = {
        beforeSnapshotId: before.snapshots[0].id,
        afterSnapshotId: after.snapshots[0].id,
        outcomeAttribute: 'success',
        errorValue: false,
        threshold: c.thresholdPercent,
        contractConfirmed: true,
      };
      const result = analyzeCumulative(before, after, options);
      expect(result.status).toBe(c.expected);
      if (!('K' in result) || !result.lower || !result.upper)
        throw new Error('SDK cumulative pair rejected');
      for (const key of ['K', 'E', 'O', 'T'] as const) expect(result[key].toString()).toBe(c[key]);
      const truthTotal = c.groundTruth.reduce((n, o) => n + BigInt(o.count), 0n);
      const truthErrors = c.groundTruth.reduce(
        (n, o) => n + (o.success ? 0n : BigInt(o.count)),
        0n,
      );
      expect(truthTotal.toString()).toBe(c.truthTotal);
      expect(truthErrors.toString()).toBe(c.truthErrors);
      expect(result.T).toBe(truthTotal);
      const truth = { numerator: truthErrors, denominator: truthTotal };
      expect(compare(truth, result.lower)).toBeGreaterThanOrEqual(0n);
      expect(compare(truth, result.upper)).toBeLessThanOrEqual(0n);
      const baseline = result.points.reduce((n, p) => n + BigInt(p.beforeCount), 0n);
      expect(baseline.toString()).toBe(c.baselineTotal);
      expect(c.baselineGroundTruth.reduce((n, p) => n + BigInt(p.count), 0n)).toBe(baseline);
      expect(result.points.reduce((n, p) => n + BigInt(p.afterCount), 0n)).toBe(
        baseline + result.T,
      );
      if (c.view) {
        expect(result.O).toBe(0n);
        expect(result.E).toBe(truthErrors);
        expect(compare(result.lower, result.upper)).toBe(0n);
      } else {
        const overflow = result.points.find((p) => p.overflow);
        expect(overflow).toBeDefined();
        expect(BigInt(overflow?.beforeCount ?? '0')).toBeGreaterThan(0n);
        expect(result.O).toBeGreaterThan(0n);
      }
      const zero = sdkStream(c.zeroFile);
      expect(
        analyzeCumulative(after, zero, {
          ...options,
          beforeSnapshotId: after.snapshots[0].id,
          afterSnapshotId: zero.snapshots[0].id,
        }),
      ).toMatchObject({ status: 'NO_DATA', T: 0n, lower: null, upper: null });
      const restart = sdkStream(c.restartFile);
      expect(
        analyzeCumulative(after, restart, {
          ...options,
          beforeSnapshotId: after.snapshots[0].id,
          afterSnapshotId: restart.snapshots[0].id,
        }),
      ).toMatchObject({ status: 'UNSUPPORTED_INPUT', diagnostic: { code: 'CHANGED_START_TIME' } });
    });
  }
});

describe('synthetic malformed controls derived from SDK exports (not SDK output)', () => {
  test.each(['decrease', 'missing', 'stream', 'boundaries'] as const)(
    '%s refuses the complete window',
    (control) => {
      const c = cumulativeCases.find((c) => !c.view);
      if (!c) throw new Error('Missing real cumulative SDK case');
      const before = sdkStream(c.beforeFile);
      const raw = JSON.parse(
        readFileSync(new URL(`../fixtures/sdk/${c.afterFile}`, import.meta.url), 'utf8'),
      );
      const metric = raw.resourceMetrics[0].scopeMetrics[0].metrics[0];
      const points = metric.sum.dataPoints;
      if (control === 'decrease') {
        const b = before.snapshots[0].points.find(
          (p) => JSON.stringify(p.attributes) === JSON.stringify(points[0].attributes),
        );
        if (!b) throw new Error('Missing matched SDK point');
        points[0].asInt = (BigInt(b.asInt as string) - 1n).toString();
      }
      if (control === 'missing') points.pop();
      if (control === 'stream') metric.unit = 'different';
      if (control === 'boundaries')
        points[0].timeUnixNano = (BigInt(points[0].timeUnixNano) + 1n).toString();
      const after = normalize(parseOtlp(JSON.stringify(raw))).streams[0];
      expect(
        analyzeCumulative(before, after, {
          beforeSnapshotId: before.snapshots[0].id,
          afterSnapshotId: after.snapshots[0].id,
          outcomeAttribute: 'success',
          errorValue: false,
          threshold: '1',
          contractConfirmed: true,
        }),
      ).toMatchObject({
        diagnostic: {
          code: {
            decrease: 'DECREASING_POINT',
            missing: 'MISSING_COUNTERPART',
            stream: 'STREAM_MISMATCH',
            boundaries: 'INCONSISTENT_TIMESTAMPS',
          }[control],
        },
      });
    },
  );
});
