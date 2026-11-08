import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { makeRouteSlowReport } from '../src/core/report';
import {
  analyzeRouteSlowShare,
  calculateRouteSlowShare,
  durationCandidates,
  millisecondsLabel,
  prepareRouteSlowShare,
  type RouteSlowSettings,
  routeCandidates,
} from '../src/core/routeSlow';
import type { Rational } from '../src/core/types';
import { importFixture, type RouteSpec, routeFixture } from './helpers';

const ratio = (numerator: bigint, denominator: bigint): Rational => ({ numerator, denominator });
const stream = (specs: RouteSpec[], metric?: Record<string, unknown>) =>
  importFixture(routeFixture(specs, metric)).streams[0];
const settings = (s: ReturnType<typeof stream>, over: Partial<RouteSlowSettings> = {}) => ({
  intervalId: s.intervals[0]?.id ?? '',
  route: '/checkout',
  durationSeconds: '0.5',
  maxSlowPercent: '1',
  contractConfirmed: true,
  ...over,
});
const run = (
  specs: RouteSpec[],
  over: Partial<RouteSlowSettings> = {},
  metric?: Record<string, unknown>,
) => {
  const s = stream(specs, metric);
  return analyzeRouteSlowShare(s, settings(s, over));
};
const code = (r: ReturnType<typeof run>) => ('diagnostic' in r ? r.diagnostic.code : r.status);
function bounds(r: ReturnType<typeof run>) {
  if (!('lower' in r) || !r.lower || !r.upper) throw new Error(`expected bounds: ${code(r)}`);
  return { lower: r.lower, upper: r.upper };
}

// Buckets (≤0.1], (0.1, 0.5], (0.5, 1], (1, ∞): the first two are fast at the 0.5 s boundary.
const route = (name: string, buckets: (number | string)[]): RouteSpec => ({ route: name, buckets });
const overflow = (buckets: (number | string)[]): RouteSpec => ({ overflow: true, buckets });
const checkout = (buckets: (number | string)[]) => route('/checkout', buckets);

describe('route slow-share bounds', () => {
  test('control example: K=900, E=9, F=90, S=10', () => {
    const r = run([
      checkout([800, 91, 5, 4]),
      route('/cart', [5000, 5, 5, 5]),
      overflow([60, 30, 7, 3]),
    ]);
    expect(r).toMatchObject({ K: 900n, E: 9n, F: 90n, S: 10n, other: 5015n });
    expect(r.status).toBe('INDETERMINATE');
    const { lower, upper } = bounds(r);
    expect(lower).toEqual(ratio(9n, 990n));
    expect(upper).toEqual(ratio(19n, 910n));
    // About 0.91% to 2.09%.
    expect(Number((lower.numerator * 10000n) / lower.denominator)).toBe(90);
    expect(Number((upper.numerator * 10000n) / upper.denominator)).toBe(208);
  });

  test('without overflow the share is exact and the overflow point may be absent or empty', () => {
    for (const extra of [[], [overflow([0, 0, 0, 0])]]) {
      const r = run([checkout([90, 0, 5, 5]), route('/cart', [0, 0, 9, 9]), ...extra], {
        maxSlowPercent: '10',
      });
      expect(r).toMatchObject({ K: 100n, E: 10n, F: 0n, S: 0n, status: 'WITHIN_LIMIT' });
      const { lower, upper } = bounds(r);
      expect(compare(lower, upper)).toBe(0n);
      expect(lower).toEqual(ratio(10n, 100n));
    }
  });

  test('overflow that is entirely fast or entirely slow', () => {
    const base = checkout([70, 20, 6, 4]); // K=100, E=10
    const fast = run([base, overflow([30, 20, 0, 0])]);
    expect(fast).toMatchObject({ F: 50n, S: 0n });
    expect(bounds(fast)).toEqual({ lower: ratio(10n, 150n), upper: ratio(10n, 100n) });
    const slow = run([base, overflow([0, 0, 30, 20])]);
    expect(slow).toMatchObject({ F: 0n, S: 50n });
    expect(bounds(slow)).toEqual({ lower: ratio(10n, 100n), upper: ratio(60n, 150n) });
  });

  test('no known slow requests, and only known slow requests', () => {
    const none = run([checkout([60, 40, 0, 0]), overflow([5, 5, 5, 5])], { maxSlowPercent: '20' });
    expect(none).toMatchObject({ K: 100n, E: 0n, F: 10n, S: 10n });
    expect(bounds(none)).toEqual({ lower: ratio(0n, 110n), upper: ratio(10n, 110n) });
    expect(none.status).toBe('WITHIN_LIMIT');
    const all = run([checkout([0, 0, 30, 70]), overflow([5, 5, 5, 5])], { maxSlowPercent: '90' });
    expect(all).toMatchObject({ K: 100n, E: 100n });
    expect(bounds(all)).toEqual({ lower: ratio(100n, 110n), upper: ratio(110n, 110n) });
    expect(all.status).toBe('EXCEEDS_LIMIT');
  });

  test('observations exactly on the boundary are fast, and the boundary chooses the split', () => {
    // All 100 observations lie in (0.1, 0.5]: exactly 0.5 is the inclusive upper bound.
    const specs = [checkout([0, 100, 0, 0]), overflow([0, 10, 0, 0])];
    expect(run(specs, { durationSeconds: '0.5' })).toMatchObject({ K: 100n, E: 0n, F: 10n, S: 0n });
    // Against the boundary 0.1 the same bucket is slow; against 1 it is still fast.
    expect(run(specs, { durationSeconds: '0.1' })).toMatchObject({ E: 100n, S: 10n, F: 0n });
    expect(run(specs, { durationSeconds: '1' })).toMatchObject({ E: 0n, S: 0n, F: 10n });
  });

  test('other routes never enter the denominator or the numerator', () => {
    const alone = run([checkout([90, 0, 10, 0]), overflow([10, 0, 5, 0])]);
    const crowded = run([
      checkout([90, 0, 10, 0]),
      route('/cart', [10_000, 0, 10_000, 0]),
      route('/checkout/legacy', [0, 0, 0, 1000]),
      route('/CHECKOUT', [0, 0, 0, 1000]),
      overflow([10, 0, 5, 0]),
    ]);
    expect(crowded).toMatchObject({ K: 100n, E: 10n, F: 10n, S: 5n, other: 22_000n });
    expect(bounds(crowded)).toEqual(bounds(alone));
  });

  test('one route may span several points; each is counted once', () => {
    const r = run([
      {
        route: '/checkout',
        buckets: [40, 0, 10, 0],
        attributes: [kv('http.request.method', 'GET')],
      },
      {
        route: '/checkout',
        buckets: [30, 0, 0, 20],
        attributes: [kv('http.request.method', 'POST')],
      },
      overflow([0, 0, 0, 1]),
    ]);
    expect(r).toMatchObject({ K: 100n, E: 30n, F: 0n, S: 1n });
  });

  describe('no confirmed observations', () => {
    test.each([
      ['empty overflow', [route('/cart', [5, 0, 5, 0])], 0n, 0n],
      ['nonempty overflow', [route('/cart', [5, 0, 5, 0]), overflow([7, 0, 3, 0])], 7n, 3n],
      ['an empty point of the route', [checkout([0, 0, 0, 0]), overflow([7, 0, 3, 0])], 7n, 3n],
    ] as [string, RouteSpec[], bigint, bigint][])('K = 0 with %s', (_name, specs, F, S) => {
      const r = run(specs, { maxSlowPercent: '100' });
      expect(r).toMatchObject({
        status: 'NO_ROUTE_OBSERVATIONS',
        K: 0n,
        E: 0n,
        F,
        S,
        lower: null,
        upper: null,
      });
      // No verdict even at the loosest and the tightest limit, and no zero share.
      expect(run(specs, { maxSlowPercent: '0' }).status).toBe('NO_ROUTE_OBSERVATIONS');
    });
    test('the selected route need not occur in the data at all', () => {
      expect(run([overflow([1, 1, 1, 1])], { route: '/never-seen' }).status).toBe(
        'NO_ROUTE_OBSERVATIONS',
      );
    });
  });

  test('counts beyond Number.MAX_SAFE_INTEGER stay exact', () => {
    const big = 9007199254740993n; // 2^53 + 1
    const r = run(
      [
        checkout([big.toString(), '0', '5', big.toString()]),
        overflow([(big + 2n).toString(), '0', (big + 4n).toString(), '1']),
      ],
      { maxSlowPercent: '50' },
    );
    const K = big + 5n + big;
    const E = 5n + big;
    const F = big + 2n;
    const S = big + 5n;
    expect(r).toMatchObject({ K, E, F, S });
    expect(bounds(r)).toEqual({ lower: ratio(E, K + F), upper: ratio(E + S, K + S) });
    // E/K is about 0.5 and the exact upper bound exceeds it, so the verdict needs exact arithmetic.
    expect(r.status).toBe('INDETERMINATE');
  });

  test('the maximum share is compared exactly with both bounds', () => {
    const specs = [checkout([80, 0, 10, 0]), overflow([10, 0, 10, 0])]; // lower 10/100, upper 20/100
    expect(run(specs, { maxSlowPercent: '20' }).status).toBe('WITHIN_LIMIT');
    expect(run(specs, { maxSlowPercent: '19.999999999999999999' }).status).toBe('INDETERMINATE');
    expect(run(specs, { maxSlowPercent: '10' }).status).toBe('INDETERMINATE');
    expect(run(specs, { maxSlowPercent: '9.999999999999999999' }).status).toBe('EXCEEDS_LIMIT');
  });

  test('reuses the prepared counts when only the maximum share changes', () => {
    const s = stream([checkout([80, 0, 10, 0]), overflow([10, 0, 10, 0])]);
    const prepared = prepareRouteSlowShare(s, settings(s));
    if (prepared.status !== 'APPLICABLE') throw new Error('expected a preparation');
    const verdicts = ['25', '15', '5'].map(
      (p) =>
        calculateRouteSlowShare(prepared, { maxSlowPercent: p, contractConfirmed: true }).status,
    );
    expect(verdicts).toEqual(['WITHIN_LIMIT', 'INDETERMINATE', 'EXCEEDS_LIMIT']);
    expect(prepared.counts).toMatchObject({ K: 90n, E: 10n, F: 10n, S: 10n });
  });

  test('provenance and the maximum share are validated after the structure', () => {
    const s = stream([checkout([1, 0, 0, 0])]);
    expect(code(analyzeRouteSlowShare(s, settings(s, { contractConfirmed: false })))).toBe(
      'PROVENANCE_NOT_CONFIRMED',
    );
    for (const bad of ['', '-1', '101', '1,5', '1e1'])
      expect(code(analyzeRouteSlowShare(s, settings(s, { maxSlowPercent: bad })))).toBe(
        'INVALID_THRESHOLD',
      );
    // A structural refusal is shown even before confirmation.
    const broken = stream([checkout([1, 0, 0, 0]), { route: null }]);
    expect(
      code(analyzeRouteSlowShare(broken, settings(broken, { contractConfirmed: false }))),
    ).toBe('MISSING_ROUTE');
  });
});

const kv = (key: string, value: string) => ({ key, value: { stringValue: value } });

describe('applicability', () => {
  test.each([
    ['a missing route', { route: null, buckets: [1, 0, 0, 0] }, 'MISSING_ROUTE'],
    ['an integer route', { routeValue: { intValue: '7' }, buckets: [1, 0, 0, 0] }, 'INVALID_ROUTE'],
    ['an empty route', { route: '', buckets: [1, 0, 0, 0] }, 'INVALID_ROUTE'],
    [
      'a route array',
      { routeValue: { arrayValue: { values: [{ stringValue: '/a' }] } }, buckets: [1, 0, 0, 0] },
      'INVALID_ROUTE',
    ],
  ] as [string, RouteSpec, string][])(
    '%s on a point of another route refuses the whole calculation',
    (_name, bad, expected) => {
      // The point could belong to the selected route, so it does not matter that it is not selected.
      expect(code(run([checkout([10, 0, 0, 0]), overflow([1, 0, 0, 0]), bad]))).toBe(expected);
    },
  );
  test('an empty ordinary point does not need a route', () => {
    const r = run([checkout([10, 0, 1, 0]), { route: null, buckets: [0, 0, 0, 0] }]);
    expect(r).toMatchObject({ K: 11n, E: 1n });
  });

  test.each([
    [
      'no bucket counts on a nonempty point',
      { route: '/cart', count: 5, buckets: [], bounds: [] },
      'MISSING_BUCKETS',
    ],
    [
      'bucket counts that do not sum to the count',
      { route: '/cart', buckets: [1, 0, 0, 0], count: 3 },
      'BUCKET_COUNT_MISMATCH',
    ],
    [
      'unsupported flags',
      { route: '/cart', buckets: [1, 0, 0, 0], point: { flags: 1 } },
      'UNSUPPORTED_FLAGS',
    ],
  ] as [string, RouteSpec, string][])('%s', (_name, bad, expected) => {
    const r = run([checkout([10, 0, 1, 0]), bad]);
    expect(code(r)).toBe(expected);
    expect(r).not.toHaveProperty('K');
  });
  test('missing buckets on the overflow and the selected route refuse as well', () => {
    const none = { count: 4, buckets: [], bounds: [] };
    expect(code(run([checkout([10, 0, 0, 0]), { overflow: true, ...none }]))).toBe(
      'MISSING_BUCKETS',
    );
    expect(code(run([{ route: '/checkout', ...none }]))).toBe('MISSING_BUCKETS');
    // An empty point without buckets is fine.
    expect(
      run([checkout([10, 0, 0, 0]), { overflow: true, count: 0, buckets: [], bounds: [] }]),
    ).toMatchObject({ K: 10n, F: 0n, S: 0n });
  });
  test('sum, min, max and exemplars never reconstruct a distribution', () => {
    const point = { sum: 100, min: 90, max: 99, exemplars: [{ asDouble: 99 }] };
    expect(code(run([{ overflow: true, count: 5, buckets: [], bounds: [], point }]))).toBe(
      'MISSING_BUCKETS',
    );
  });

  test('the duration must be an exact bound of the overflow and selected-route points', () => {
    const other = { bounds: [0.1, 0.4, 1] };
    // The boundary 0.5 is missing from the overflow bounds.
    expect(
      code(run([checkout([1, 0, 0, 0]), { overflow: true, buckets: [1, 0, 0, 0], ...other }])),
    ).toBe('THRESHOLD_NOT_A_BOUNDARY');
    // ...or from one selected-route point out of several.
    expect(
      code(run([checkout([1, 0, 0, 0]), { route: '/checkout', buckets: [1, 0, 0, 0], ...other }])),
    ).toBe('THRESHOLD_NOT_A_BOUNDARY');
    // A neighbouring value is never accepted, nor an equivalent spelling of a different one.
    for (const near of ['0.4999999999', '0.5000000001', '500'])
      expect(code(run([checkout([1, 0, 0, 0])], { durationSeconds: near }))).toBe(
        'THRESHOLD_NOT_A_BOUNDARY',
      );
    // Equal numeric values in another spelling match the same boundary.
    expect(run([checkout([1, 0, 0, 0])], { durationSeconds: '0.50' })).toMatchObject({ K: 1n });
    // Other routes do not take part in the split, so their layouts do not matter.
    expect(
      run([
        checkout([5, 0, 0, 0]),
        route('/cart', [1, 0, 0, 0]),
        { route: '/cart2', buckets: [1, 0, 0, 0], ...other },
      ]),
    ).toMatchObject({ K: 5n });
  });

  test.each([
    ['', 'DURATION_NOT_SELECTED'],
    ['0', 'INVALID_DURATION_THRESHOLD'],
    ['-0.5', 'INVALID_DURATION_THRESHOLD'],
    ['abc', 'INVALID_DURATION_THRESHOLD'],
    ['Infinity', 'INVALID_DURATION_THRESHOLD'],
    ['1e999', 'INVALID_DURATION_THRESHOLD'],
  ])('duration threshold %j', (durationSeconds, expected) => {
    expect(code(run([checkout([1, 0, 0, 0])], { durationSeconds }))).toBe(expected);
  });
  test('an interval and a route are required', () => {
    expect(code(run([checkout([1, 0, 0, 0])], { route: '' }))).toBe('ROUTE_NOT_SELECTED');
    expect(code(run([checkout([1, 0, 0, 0])], { intervalId: 'x' }))).toBe('INTERVAL_NOT_SELECTED');
  });

  test('the unit must be seconds; nothing is converted', () => {
    for (const unit of ['ms', '', 'By'])
      expect(code(run([checkout([1, 0, 0, 0])], {}, { unit }))).toBe('UNSUPPORTED_UNIT');
  });
  test('only delta temporality, the duration metric and histograms', () => {
    const cumulative = routeFixture([checkout([1, 0, 0, 0])]);
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality = 2;
    const s = importFixture(cumulative).streams[0];
    expect(code(analyzeRouteSlowShare(s, settings(s)))).toBe('UNSUPPORTED_TEMPORALITY');
    expect(code(run([checkout([1, 0, 0, 0])], {}, { name: 'http.client.request.duration' }))).toBe(
      'UNSUPPORTED_METRIC',
    );
    const sum = importFixture({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'http.server.request.duration',
                  unit: 's',
                  sum: {
                    isMonotonic: true,
                    aggregationTemporality: 1,
                    dataPoints: [
                      { asInt: '1', startTimeUnixNano: '1', timeUnixNano: '2', attributes: [] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }).streams[0];
    expect(code(analyzeRouteSlowShare(sum, settings(sum, { intervalId: '1:2' })))).toBe(
      'UNSUPPORTED_TYPE',
    );
  });

  test('overflow must have the strict SDK shape and points must be unique', () => {
    expect(
      code(
        run([checkout([1, 0, 0, 0]), { ...overflow([1, 0, 0, 0]), attributes: [kv('a', 'b')] }]),
      ),
    ).toBe('AMBIGUOUS_OVERFLOW');
    const duplicate = routeFixture([checkout([1, 0, 0, 0])]);
    const points = duplicate.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
    points.push(structuredClone(points[0]));
    const s = importFixture(duplicate).streams[0];
    expect(code(analyzeRouteSlowShare(s, settings(s)))).toBe('DUPLICATE_POINT');
  });

  test('an interval with unequal overlapping boundaries is refused by the importer', () => {
    const raw = routeFixture([checkout([1, 0, 0, 0]), checkout([1, 0, 0, 0])]);
    raw.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[1].startTimeUnixNano =
      '1500000000';
    const s = importFixture(raw).streams[0];
    expect(code(analyzeRouteSlowShare(s, settings(s)))).toBe('INCOMPATIBLE_INTERVALS');
  });
});

describe('selection helpers', () => {
  const s = stream([
    checkout([1, 0, 0, 0]),
    route('/cart', [1, 0, 0, 0]),
    route('/cart', [1, 0, 0, 0]),
    { route: null, buckets: [0, 0, 0, 0] },
    overflow([1, 0, 0, 0]),
  ]);
  const id = s.intervals[0].id;
  test('routes are the exact distinct ordinary values', () => {
    expect(routeCandidates(s, id)).toEqual(['/cart', '/checkout']);
  });
  test('boundaries are offered in seconds, only when shared by the participating points', () => {
    expect(durationCandidates(s, id, '/checkout')).toEqual(['0.1', '0.5', '1']);
    expect(durationCandidates(s, id, '')).toEqual([]);
    const mixed = stream([
      checkout([1, 0, 0, 0]),
      { overflow: true, buckets: [1, 0, 0, 0], bounds: [0.5, 2, 4] },
    ]);
    expect(durationCandidates(mixed, mixed.intervals[0].id, '/checkout')).toEqual(['0.5']);
  });
  test('milliseconds are display-only and exact seconds remain the selection', () => {
    expect(millisecondsLabel('0.5')).toBe('500 ms');
    expect(millisecondsLabel('0.007')).toBe('7 ms');
    expect(millisecondsLabel('0.075')).toBe('75 ms');
  });
});

describe('explanatory report', () => {
  const build = (specs: RouteSpec[], over: Partial<RouteSlowSettings> = {}) => {
    const s = stream(specs);
    const set = settings(s, over);
    const prepared = prepareRouteSlowShare(s, set);
    const result = calculateRouteSlowShare(prepared, set);
    const source = { name: 'in.json', sha256: 'f'.repeat(64), bytes: 1 };
    return JSON.parse(makeRouteSlowReport(s, set, prepared, result, source));
  };
  test('records selection, counts, exact fractions, witnesses and the unknown attribution', () => {
    const r = build([checkout([800, 91, 5, 4]), overflow([60, 30, 7, 3])]);
    expect(r).toMatchObject({
      reportVersion: '5',
      mode: 'http-route-slow-share-histogram',
      source: { sha256: 'f'.repeat(64) },
      inputMetric: { name: 'http.server.request.duration', unit: 's' },
      selection: {
        route: { attribute: 'http.route', value: '/checkout' },
        durationThreshold: { seconds: '0.5', unit: 's' },
      },
      assumptions: { userConfirmed: true, structurallyProven: false },
      counts: { K: '900', E: '9', F: '90', S: '10' },
      result: {
        status: 'INDETERMINATE',
        lower: { numerator: '9', denominator: '990' },
        upper: { numerator: '19', denominator: '910' },
        maximum: { numerator: '1', denominator: '100' },
      },
      model: { lower: 'E / (K + F)', upper: '(E + S) / (K + S)' },
      witnesses: {
        lower: { overflowFastOfSelectedRoute: '90', overflowSlowOfSelectedRoute: '0' },
        upper: { overflowFastOfSelectedRoute: '0', overflowSlowOfSelectedRoute: '10' },
      },
    });
    expect(r.unknownAttribution.explanation).toContain('http.route');
    expect(r.assumptions.conditions).toHaveLength(5);
    expect(r.points).toHaveLength(2);
    expect(r.settings).toEqual({
      intervalId: '1000000000:2000000000',
      route: '/checkout',
      durationSeconds: '0.5',
      maxSlowPercent: '1',
      contractConfirmed: true,
    });
  });
  test('the no-observation result exports no share, bound, witness or verdict', () => {
    const r = build([route('/cart', [5, 0, 0, 0]), overflow([4, 0, 3, 0])]);
    expect(r.result.status).toBe('NO_ROUTE_OBSERVATIONS');
    expect(r.result.lower).toBeNull();
    expect(r.result.upper).toBeNull();
    expect(r.witnesses).toBeNull();
    expect(r.counts).toMatchObject({ K: '0', F: '4', S: '3' });
    expect(JSON.stringify(r)).not.toContain('WITHIN_LIMIT');
  });
  test('refusals and unconfirmed requests export no counts', () => {
    const refused = build([{ route: null, buckets: [1, 0, 0, 0] }]);
    expect(refused.result.diagnostic.code).toBe('MISSING_ROUTE');
    expect(refused.counts).toBeNull();
    expect(refused.points).toBeNull();
    const unconfirmed = build([checkout([1, 0, 0, 0])], { contractConfirmed: false });
    expect(unconfirmed.result.diagnostic.code).toBe('PROVENANCE_NOT_CONFIRMED');
    expect(unconfirmed.counts).toBeNull();
  });
});

describe('exhaustive check of the formulas', () => {
  // For every split of the overflow between the selected route and other routes, the
  // route's share is (E + s) / (K + f + s) with 0 <= f <= F fast and 0 <= s <= S slow
  // observations. The extremes among them must be exactly lower and upper.
  test('lower and upper are the minimum and maximum over all assignments, for K > 0', () => {
    let cases = 0;
    for (let K = 1; K <= 7; K++)
      for (let E = 0; E <= K; E++)
        for (let F = 0; F <= 6; F++)
          for (let S = 0; S <= 6; S++) {
            const r = run([
              checkout([K - E, 0, E, 0]),
              route('/other', [3, 0, 3, 0]),
              overflow([F, 0, S, 0]),
            ]);
            const { lower, upper } = bounds(r);
            let min: Rational | undefined;
            let max: Rational | undefined;
            for (let f = 0; f <= F; f++)
              for (let s = 0; s <= S; s++) {
                const share = ratio(BigInt(E + s), BigInt(K + f + s));
                if (!min || compare(share, min) < 0n) min = share;
                if (!max || compare(share, max) > 0n) max = share;
                cases++;
              }
            if (!min || !max) throw new Error('empty enumeration');
            expect(compare(lower, min)).toBe(0n);
            expect(compare(upper, max)).toBe(0n);
          }
    expect(cases).toBeGreaterThan(10_000);
  });
});
