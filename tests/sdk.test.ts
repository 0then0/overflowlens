import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
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
