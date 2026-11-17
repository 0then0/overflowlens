import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { analyzeRouteSlowShare, type RouteSlowAnalysis } from '../src/core/routeSlow';
import type { Rational } from '../src/core/types';

type Evidence = {
  name: string;
  file: string;
  cardinalityLimit: number;
  observations: number;
  ordinaryPoints: number;
  overflowPoints: number;
  selectedRouteKnownRequests: string;
  overflowCount: string;
  otherRoutesKnown: string;
  points: { route: string; overflow: boolean; scale: number; offset: number; zeroCount: number }[];
  truthSelectedRoute: { thresholdSeconds: string; requests: string; slow: string }[];
  journal: { route: string; method: string; retainedBySDK: boolean; requests: number }[];
  plan: { route: string; method: string; seconds: number; count: number }[];
};
const read = (name: string) =>
  readFileSync(new URL(`../fixtures/http/${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('route-exp-manifest.json')) as {
  modules: Record<string, string>;
  unit: string;
  aggregation: string;
  selectedRoute: string;
  durationThresholdsSeconds: string[];
  purpose: string;
  notMeasured: string;
  bucketPlacementCheck: string;
  cases: Evidence[];
};
const byName = (name: string) => {
  const c = manifest.cases.find((x) => x.name === name);
  if (!c) throw new Error(`missing case ${name}`);
  return c;
};
const load = (c: Evidence) => {
  const data = normalize(parseOtlp(read(c.file)));
  const stream = data.streams.find((s) => s.identity.name === 'http.server.request.duration');
  if (!stream) throw new Error('missing stream');
  return { data, stream };
};
const analyze = (c: Evidence, durationSeconds: string, maxSlowPercent = '10') => {
  const { stream } = load(c);
  return analyzeRouteSlowShare(stream, {
    intervalId: stream.intervals[0].id,
    route: manifest.selectedRoute,
    durationSeconds,
    maxSlowPercent,
    contractConfirmed: true,
  });
};
const truthOf = (c: Evidence, threshold: string): Rational => {
  const t = c.truthSelectedRoute.find((x) => x.thresholdSeconds === threshold);
  if (!t) throw new Error(`missing truth for ${threshold}`);
  return { numerator: BigInt(t.slow), denominator: BigInt(t.requests) };
};
function bounds(r: RouteSlowAnalysis) {
  if (!('lower' in r) || !r.lower || !r.upper) throw new Error(JSON.stringify(r));
  return { lower: r.lower, upper: r.upper };
}
const width = (b: { lower: Rational; upper: Rational }) => ({
  numerator: b.upper.numerator * b.lower.denominator - b.lower.numerator * b.upper.denominator,
  denominator: b.upper.denominator * b.lower.denominator,
});

describe('real Go SDK exponential histogram exports with directly recorded durations', () => {
  test('the manifest pins the SDK, the aggregation and the independent placement check', () => {
    expect(manifest.modules['go.opentelemetry.io/otel/sdk/metric']).toBe('v1.47.0');
    expect(manifest.unit).toBe('s');
    expect(manifest.aggregation).toContain('AggregationBase2ExponentialHistogram');
    expect(manifest.purpose).toContain('no HTTP server');
    expect(manifest.notMeasured).toContain('not a measurement of real HTTP latency');
    expect(manifest.bucketPlacementCheck).toContain('exact');
  });

  for (const c of manifest.cases)
    describe(c.file, () => {
      test('the journal matches the plan and the truth comes from the plan alone', () => {
        const planned = c.plan.reduce((n, g) => n + g.count, 0);
        expect(c.observations).toBe(planned);
        expect(c.journal.reduce((n, s) => n + s.requests, 0)).toBe(planned);
        const selected = c.plan.filter((g) => g.route === manifest.selectedRoute);
        for (const t of c.truthSelectedRoute) {
          expect(Number(t.requests)).toBe(selected.reduce((n, g) => n + g.count, 0));
          // The recorded doubles are compared with the decimal threshold; 0.3 as a double is
          // slightly below 0.3, so it is not slow.
          expect(Number(t.slow)).toBe(
            selected
              .filter((g) => g.seconds > Number(t.thresholdSeconds))
              .reduce((n, g) => n + g.count, 0),
          );
        }
      });

      test('the export imports as a delta seconds ExponentialHistogram', () => {
        const { data, stream } = load(c);
        expect(data.diagnostics).toEqual([]);
        expect(stream.diagnostics).toEqual([]);
        expect(stream.identity).toMatchObject({
          type: 'exponentialHistogram',
          temporality: 'DELTA',
          unit: 's',
        });
        expect(stream.intervals).toHaveLength(1);
        expect(stream.intervals[0].points).toHaveLength(c.ordinaryPoints + c.overflowPoints);
      });

      for (const threshold of manifest.durationThresholdsSeconds)
        test(`at ${threshold} s the true share lies within the bounds`, () => {
          const r = analyze(c, threshold);
          if (!('K' in r)) throw new Error(JSON.stringify(r));
          expect(r.K.toString()).toBe(c.selectedRouteKnownRequests);
          expect((r.F + r.S + r.X).toString()).toBe(c.overflowCount);
          expect(r.other.toString()).toBe(c.otherRoutesKnown);
          if (r.status === 'NO_ROUTE_OBSERVATIONS') return;
          const { lower, upper } = bounds(r);
          const truth = truthOf(c, threshold);
          expect(compare(truth, lower)).toBeGreaterThanOrEqual(0n);
          expect(compare(truth, upper)).toBeLessThanOrEqual(0n);
        });
    });

  test('points carry different scales and offsets', () => {
    const c = byName('route-exp-overflow');
    expect(new Set(c.points.map((p) => p.scale)).size).toBeGreaterThan(2);
    expect(new Set(c.points.map((p) => p.offset)).size).toBe(c.points.length);
    expect(c.points.some((p) => p.zeroCount > 0)).toBe(true);
  });

  test('without overflow, a threshold inside a bucket still leaves a range', () => {
    const c = byName('route-exp-no-overflow');
    expect(c.overflowPoints).toBe(0);
    const r = analyze(c, '0.3');
    if (!('K' in r)) throw new Error(JSON.stringify(r));
    expect([r.F, r.S, r.X]).toEqual([0n, 0n, 0n]);
    expect(r.B).toBeGreaterThan(0n);
    const b = bounds(r);
    const truth = truthOf(c, '0.3');
    expect(compare(b.lower, b.upper)).toBeLessThan(0n);
    expect(compare(truth, b.lower)).toBeGreaterThan(0n);
    expect(compare(truth, b.upper)).toBeLessThan(0n);
  });

  test('at a power-of-two boundary nothing is uncertain without overflow: one exact share', () => {
    const c = byName('route-exp-no-overflow');
    const r = analyze(c, '0.5');
    if (!('K' in r)) throw new Error(JSON.stringify(r));
    expect(r.B).toBe(0n);
    const b = bounds(r);
    expect(compare(b.lower, b.upper)).toBe(0n);
    expect(compare(b.lower, truthOf(c, '0.5'))).toBe(0n);
  });

  test('route loss widens the range beyond the threshold uncertainty alone', () => {
    const withOverflow = analyze(byName('route-exp-overflow'), '0.3');
    const without = analyze(byName('route-exp-no-overflow'), '0.3');
    if (!('K' in withOverflow) || !('K' in without)) throw new Error('expected counts');
    expect(withOverflow.F + withOverflow.S + withOverflow.X).toBeGreaterThan(0n);
    const a = bounds(withOverflow);
    const b = bounds(without);
    expect(compare(width(a), width(b))).toBeGreaterThan(0n);
    expect(compare(a.lower, b.lower)).toBeLessThan(0n);
    expect(compare(a.upper, b.upper)).toBeGreaterThan(0n);
    // The selected route really has requests in the overflow (its POST attribute set).
    const lost = byName('route-exp-overflow').journal.filter((s) => !s.retainedBySDK);
    expect(lost.some((s) => s.route === manifest.selectedRoute)).toBe(true);
    expect(new Set(lost.map((s) => s.route)).size).toBeGreaterThan(2);
  });

  test('a route without ordinary points yields no verdict', () => {
    const c = byName('route-exp-absent');
    for (const threshold of manifest.durationThresholdsSeconds)
      expect(analyze(c, threshold)).toMatchObject({
        status: 'NO_ROUTE_OBSERVATIONS',
        K: 0n,
        lower: null,
        upper: null,
      });
    expect(Number(c.truthSelectedRoute[0].requests)).toBeGreaterThan(0);
  });
});
