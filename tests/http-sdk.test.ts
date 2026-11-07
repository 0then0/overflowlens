import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { runHttp } from './helpers';

type Evidence = {
  file: string;
  cardinalityLimit: number;
  K: string;
  E: string;
  O: string;
  T: string;
  ordinaryPoints: number;
  overflowPoints: number;
  truthTotal: string;
  truthServerErrors: string;
  observedStatuses: { status: number; count: number }[];
};
const read = (name: string) =>
  readFileSync(new URL(`../fixtures/http/${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as {
  modules: Record<string, string>;
  semconv: string;
  temporality: string;
  aggregation: string;
  explicitBounds: number[];
  views: string;
  workload: { status: number; count: number }[];
  cases: Evidence[];
};

describe('real Go otelhttp exports', () => {
  test('the manifest pins the instrumentation and aggregation configuration', () => {
    expect(manifest.modules['go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp']).toBe(
      'v0.72.0',
    );
    expect(manifest.modules['go.opentelemetry.io/otel/sdk/metric']).toBe('v1.47.0');
    expect(manifest.semconv).toContain('v1.43.0');
    expect(manifest.temporality).toContain('delta');
    expect(manifest.aggregation).toContain('explicit bucket');
    expect(manifest.views).toBe('none');
    expect(manifest.explicitBounds).toHaveLength(14);
  });
  for (const c of manifest.cases)
    describe(c.file, () => {
      const data = normalize(parseOtlp(read(c.file)));
      const duration = data.streams.find((s) => s.identity.name === 'http.server.request.duration');
      test('the independent workload tally matches the plan and ground truth', () => {
        const planned = new Map<number, number>();
        for (const step of manifest.workload)
          planned.set(step.status, (planned.get(step.status) ?? 0) + step.count);
        expect(c.observedStatuses).toEqual(
          [...planned].sort(([a], [b]) => a - b).map(([status, count]) => ({ status, count })),
        );
        const total = c.observedStatuses.reduce((n, o) => n + o.count, 0);
        const errors = c.observedStatuses
          .filter((o) => o.status >= 500)
          .reduce((n, o) => n + o.count, 0);
        expect([String(total), String(errors)]).toEqual([c.truthTotal, c.truthServerErrors]);
      });
      test('the file imports cleanly and contains the three HTTP histograms', () => {
        expect(data.diagnostics).toEqual([]);
        expect(data.streams.map((s) => s.identity.name).sort()).toEqual([
          'http.server.request.body.size',
          'http.server.request.duration',
          'http.server.response.body.size',
        ]);
        expect(data.streams.every((s) => !s.diagnostics.length)).toBe(true);
        expect(duration?.identity).toMatchObject({
          type: 'histogram',
          temporality: 'DELTA',
          unit: 's',
        });
        expect(duration?.intervals).toHaveLength(1);
      });
      test('bounds reproduce the SDK counts and contain the true 5xx share', () => {
        if (!duration) throw new Error('missing stream');
        const result = runHttp(duration);
        if (!('K' in result) || !result.lower || !result.upper)
          throw new Error(JSON.stringify(result));
        for (const key of ['K', 'E', 'O', 'T'] as const)
          expect(result[key].toString()).toBe(c[key]);
        expect(result.T).toBe(BigInt(c.truthTotal));
        const truth = { numerator: BigInt(c.truthServerErrors), denominator: BigInt(c.truthTotal) };
        expect(compare(truth, result.lower)).toBeGreaterThanOrEqual(0n);
        expect(compare(truth, result.upper)).toBeLessThanOrEqual(0n);
        expect(result.points.filter((p) => !p.overflow)).toHaveLength(c.ordinaryPoints);
        expect(result.points.filter((p) => p.overflow)).toHaveLength(c.overflowPoints);
        if (c.overflowPoints === 0) {
          expect(result.O).toBe(0n);
          expect(compare(result.lower, result.upper)).toBe(0n);
          expect(result.E).toBe(BigInt(c.truthServerErrors));
        } else {
          expect(result.O).toBeGreaterThan(0n);
        }
      });
      test('other HTTP histograms in the same file are not accepted as the metric', () => {
        for (const s of data.streams.filter((s) => s !== duration))
          expect(runHttp(s)).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_METRIC' } });
      });
    });
  test('the overflow case really exceeded the small SDK limit', () => {
    const [overflow, exact] = manifest.cases;
    expect(overflow.cardinalityLimit).toBe(8);
    expect(overflow.ordinaryPoints + overflow.overflowPoints).toBeLessThanOrEqual(
      overflow.cardinalityLimit,
    );
    expect(Number(overflow.O)).toBeGreaterThan(0);
    expect(exact.overflowPoints).toBe(0);
    expect(exact.ordinaryPoints).toBeGreaterThan(overflow.cardinalityLimit);
  });
});
