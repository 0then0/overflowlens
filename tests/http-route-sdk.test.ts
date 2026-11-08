import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { analyzeRouteSlowShare, durationCandidates, routeCandidates } from '../src/core/routeSlow';

type Evidence = {
  name: string;
  file: string;
  cardinalityLimit: number;
  observations: number;
  K: string;
  E: string;
  F: string;
  S: string;
  otherRoutesKnown: string;
  ordinaryPoints: number;
  overflowPoints: number;
  truthSelectedRoute: { requests: string; slow: string; exactlyAtThreshold: string };
  journal: {
    route: string;
    method: string;
    retainedBySDK: boolean;
    requests: number;
    notSlower: number;
    slower: number;
    exactlyAtThreshold: number;
  }[];
  plan: { route: string; method: string; seconds: number; count: number }[];
};
const read = (name: string) =>
  readFileSync(new URL(`../fixtures/http/${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('route-manifest.json')) as {
  modules: Record<string, string>;
  unit: string;
  temporality: string;
  explicitBounds: number[];
  selectedRoute: string;
  durationThresholdSeconds: number;
  purpose: string;
  notMeasured: string;
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
const analyze = (c: Evidence, maxSlowPercent = '1', route = manifest.selectedRoute) => {
  const { stream } = load(c);
  return analyzeRouteSlowShare(stream, {
    intervalId: stream.intervals[0].id,
    route,
    durationSeconds: String(manifest.durationThresholdSeconds),
    maxSlowPercent,
    contractConfirmed: true,
  });
};

describe('real Go SDK Histogram exports with directly recorded durations', () => {
  test('the manifest pins the SDK and states what is not measured', () => {
    expect(manifest.modules['go.opentelemetry.io/otel/sdk/metric']).toBe('v1.47.0');
    expect(manifest.modules['go.opentelemetry.io/otel/metric']).toBe('v1.47.0');
    expect(manifest.unit).toBe('s');
    expect(manifest.temporality).toContain('delta');
    expect(manifest.explicitBounds).toContain(manifest.durationThresholdSeconds);
    expect(manifest.purpose).toContain('no HTTP server');
    expect(manifest.notMeasured).toContain('not a measurement of real HTTP latency');
  });

  for (const c of manifest.cases)
    describe(c.file, () => {
      test('the independent journal matches the plan and the SDK conserved every observation', () => {
        const planned = c.plan.reduce((n, g) => n + g.count, 0);
        expect(c.observations).toBe(planned);
        expect(c.journal.reduce((n, s) => n + s.requests, 0)).toBe(planned);
        const sel = c.journal.filter((s) => s.route === manifest.selectedRoute);
        const fromPlan = c.plan.filter((g) => g.route === manifest.selectedRoute);
        expect(Number(c.truthSelectedRoute.requests)).toBe(
          fromPlan.reduce((n, g) => n + g.count, 0),
        );
        expect(Number(c.truthSelectedRoute.slow)).toBe(
          fromPlan
            .filter((g) => g.seconds > manifest.durationThresholdSeconds)
            .reduce((n, g) => n + g.count, 0),
        );
        expect(sel.reduce((n, s) => n + s.slower, 0)).toBe(Number(c.truthSelectedRoute.slow));
        expect(Number(c.K) + Number(c.F) + Number(c.S) + Number(c.otherRoutesKnown)).toBe(planned);
      });

      test('the export imports cleanly as a delta seconds histogram', () => {
        const { data, stream } = load(c);
        expect(data.diagnostics).toEqual([]);
        expect(stream.diagnostics).toEqual([]);
        expect(stream.identity).toMatchObject({
          type: 'histogram',
          temporality: 'DELTA',
          unit: 's',
        });
        expect(stream.intervals).toHaveLength(1);
        const points = stream.intervals[0].points;
        expect(points).toHaveLength(c.ordinaryPoints + c.overflowPoints);
      });

      test('OverflowLens reproduces the SDK counts and contains the true slow share', () => {
        const r = analyze(c);
        if (!('K' in r)) throw new Error(JSON.stringify(r));
        expect([r.K, r.E, r.F, r.S, r.other].map(String)).toEqual([
          c.K,
          c.E,
          c.F,
          c.S,
          c.otherRoutesKnown,
        ]);
        const requests = BigInt(c.truthSelectedRoute.requests);
        const slow = BigInt(c.truthSelectedRoute.slow);
        if (r.status === 'NO_ROUTE_OBSERVATIONS') return;
        if (!r.lower || !r.upper) throw new Error('expected bounds');
        const truth = { numerator: slow, denominator: requests };
        expect(compare(truth, r.lower)).toBeGreaterThanOrEqual(0n);
        expect(compare(truth, r.upper)).toBeLessThanOrEqual(0n);
      });
    });

  test('with overflow: both sides are attainable but not exact, and the truth is strictly inside', () => {
    const c = byName('route-overflow');
    expect(c.cardinalityLimit).toBe(5);
    expect(BigInt(c.F)).toBeGreaterThan(0n);
    expect(BigInt(c.S)).toBeGreaterThan(0n);
    // Overflow has fast and slow observations of several routes, and of the selected route itself.
    const lost = c.journal.filter((s) => !s.retainedBySDK);
    expect(new Set(lost.map((s) => s.route)).size).toBeGreaterThan(2);
    expect(
      lost.some((s) => s.route === manifest.selectedRoute && s.slower > 0 && s.notSlower > 0),
    ).toBe(true);
    const r = analyze(c);
    if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
    const truth = {
      numerator: BigInt(c.truthSelectedRoute.slow),
      denominator: BigInt(c.truthSelectedRoute.requests),
    };
    expect(compare(truth, r.lower)).toBeGreaterThan(0n);
    expect(compare(truth, r.upper)).toBeLessThan(0n);
    // The truth is 4%: undecidable at 5%, excluded above 10%, refuted below 1.5%.
    expect(analyze(c, '5').status).toBe('INDETERMINATE');
    expect(analyze(c, '10').status).toBe('WITHIN_LIMIT');
    expect(analyze(c, '1.5').status).toBe('EXCEEDS_LIMIT');
    // Counting all overflow as the selected route's, or dividing by all requests, would be wrong.
    expect(r.other).toBeGreaterThan(0n);
  });

  test('without overflow the control gives one exact share', () => {
    const c = byName('route-no-overflow');
    expect(c.overflowPoints).toBe(0);
    const r = analyze(c);
    if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
    expect(compare(r.lower, r.upper)).toBe(0n);
    expect([r.K, r.E, r.F, r.S]).toEqual([500n, 20n, 0n, 0n]);
    expect(r.lower).toEqual({ numerator: 20n, denominator: 500n });
    expect(analyze(c, '4').status).toBe('WITHIN_LIMIT');
    expect(analyze(c, '3.999999999999999999').status).toBe('EXCEEDS_LIMIT');
  });

  test('observations exactly at the boundary were recorded and counted as fast', () => {
    for (const c of manifest.cases) {
      const atBoundary = c.plan
        .filter(
          (g) =>
            g.route === manifest.selectedRoute && g.seconds === manifest.durationThresholdSeconds,
        )
        .reduce((n, g) => n + g.count, 0);
      expect(atBoundary).toBeGreaterThan(0);
      expect(Number(c.truthSelectedRoute.exactlyAtThreshold)).toBe(atBoundary);
    }
    // Using the neighbouring lower boundary would move them to the slow side.
    const c = byName('route-no-overflow');
    const { stream } = load(c);
    const lower = analyzeRouteSlowShare(stream, {
      intervalId: stream.intervals[0].id,
      route: manifest.selectedRoute,
      durationSeconds: '0.25',
      maxSlowPercent: '100',
      contractConfirmed: true,
    });
    expect(lower).toMatchObject({ E: 80n });
  });

  test('a route without ordinary points yields no verdict although overflow holds its requests', () => {
    const c = byName('route-absent');
    const { stream } = load(c);
    expect(routeCandidates(stream, stream.intervals[0].id)).not.toContain(manifest.selectedRoute);
    const r = analyze(c);
    expect(r).toMatchObject({ status: 'NO_ROUTE_OBSERVATIONS', K: 0n, lower: null, upper: null });
    // The route really had requests, but the file cannot show that.
    expect(Number(c.truthSelectedRoute.requests)).toBeGreaterThan(0);
    expect(BigInt(c.F) + BigInt(c.S)).toBeGreaterThan(0n);
  });

  test('the shared boundaries are offered in seconds', () => {
    const { stream } = load(byName('route-overflow'));
    expect(durationCandidates(stream, stream.intervals[0].id, manifest.selectedRoute)).toEqual(
      manifest.explicitBounds.map(String),
    );
  });
});
