import { describe, expect, test } from 'vitest';
import { analyzeCumulative, pairCumulative } from '../src/core/cumulative';
import {
  analyzeHttpCumulative,
  calculateHttpCumulative,
  type HttpCumulativeSettings,
  pairHttpCumulative,
} from '../src/core/httpCumulative';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { makeHttpCumulativeReport } from '../src/core/report';
import { type Analysis, HTTP_CUMULATIVE_CONTRACT } from '../src/core/types';
import {
  type CumulativePoint,
  type CumulativePointSpec,
  fixture,
  httpCumulativeFixture,
  httpFixture,
  importFixture,
  runHttp,
} from './helpers';

type Raw = ReturnType<typeof httpCumulativeFixture>;
type Counts = { ok: string; five: string; four: string; ovf: string };
const specs = (c: Counts): CumulativePointSpec[] => [
  { id: 'ok', status: 200, count: c.ok },
  { id: 'five', status: 500, count: c.five },
  { id: 'four', status: 404, count: c.four },
  { id: 'ovf', overflow: true, count: c.ovf },
];
// Window increments: 800 + 100 known successes/other, 10 known 5xx, 90 overflow: T = 1000.
const BEFORE: Counts = { ok: '100', five: '7', four: '3', ovf: '5' };
const AFTER: Counts = { ok: '900', five: '17', four: '103', ovf: '95' };
function pairRaw(before = BEFORE, after = AFTER) {
  return {
    before: httpCumulativeFixture(specs(before), '2000000000'),
    after: httpCumulativeFixture(specs(after), '3000000000'),
  };
}
const points = (f: Raw): CumulativePoint[] =>
  f.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
const metric = (f: Raw) => f.resourceMetrics[0].scopeMetrics[0].metrics[0];
const point = (f: Raw, id: string) => {
  const found = points(f).find((p) =>
    p.attributes.some(
      (a) =>
        (a.key === 'test.id' && (a.value as { stringValue: string }).stringValue === id) ||
        (id === 'ovf' && a.key === 'otel.metric.overflow'),
    ),
  );
  if (!found) throw new Error(`missing ${id}`);
  return found;
};
function imported(raw: ReturnType<typeof pairRaw>) {
  const before = structuredClone(importFixture(raw.before)).streams[0],
    after = structuredClone(importFixture(raw.after)).streams[0];
  const options: HttpCumulativeSettings = {
    beforeSnapshotId: before.snapshots[0]?.id ?? '',
    afterSnapshotId: after.snapshots[0]?.id ?? '',
    threshold: '1',
    contractConfirmed: true,
  };
  return { before, after, options };
}
function result(raw = pairRaw(), overrides: Partial<HttpCumulativeSettings> = {}) {
  const { before, after, options } = imported(raw);
  return analyzeHttpCumulative(before, after, { ...options, ...overrides });
}
const code = (r: Analysis | ReturnType<typeof result>) =>
  'diagnostic' in r ? r.diagnostic.code : r.status;
const sources = {
  before: { name: 'before.json', sha256: 'a'.repeat(64), bytes: 10 },
  after: { name: 'after.json', sha256: 'b'.repeat(64), bytes: 20 },
};

describe('cumulative HTTP 5xx windows: counts', () => {
  test('baseline observations are excluded and equality with the threshold is exact', () => {
    const r = result(pairRaw(), { threshold: '10' });
    expect(r).toMatchObject({
      status: 'WITHIN_LIMIT',
      K: 910n,
      E: 10n,
      O: 90n,
      T: 1000n,
      lower: { numerator: 10n, denominator: 1000n },
      upper: { numerator: 100n, denominator: 1000n },
    });
    if (!('evidence' in r)) throw new Error('expected a window');
    // The 115 requests before the first snapshot and the 1,115 at the second are not the window.
    const sum = (key: 'beforeCount' | 'afterCount' | 'count') =>
      r.points.reduce((n, p) => n + BigInt(p[key]), 0n);
    expect([sum('beforeCount'), sum('afterCount'), sum('count')]).toEqual([115n, 1115n, 1000n]);
    expect(result(pairRaw(), { threshold: '9.99999999999999999999' }).status).toBe('INDETERMINATE');
    // The lower bound equals the threshold exactly: equality is not exceeding.
    expect(result(pairRaw(), { threshold: '1' }).status).toBe('INDETERMINATE');
    expect(result(pairRaw(), { threshold: '0.99999999999999999999' }).status).toBe('EXCEEDS_LIMIT');
  });

  test('status classes: 500 to 599 are 5xx, every other valid status is not', () => {
    const statuses = [100, 199, 200, 404, 499, 500, 503, 599];
    const f = (n: number) =>
      httpCumulativeFixture(
        statuses.map((status) => ({ id: String(status), status, count: n })),
        n === 0 ? '2000000000' : '3000000000',
      );
    const r = result({ before: f(0), after: f(2) });
    expect(r).toMatchObject({ K: 16n, E: 6n, O: 0n, T: 16n });
    if (!('points' in r)) throw new Error('expected points');
    expect(r.points.map((p) => [p.statusCode, p.responseClass])).toEqual(
      [...statuses.map(String)].sort().map((s) => [s, Number(s) >= 500 ? 'server_error' : 'other']),
    );
  });

  test('point and attribute order do not change matching, counts or points', () => {
    const base = result();
    const raw = pairRaw();
    points(raw.after).reverse();
    for (const p of points(raw.after)) p.attributes.reverse();
    for (const p of [...points(raw.before)]) p.attributes.reverse();
    const first = points(raw.before).splice(0, 2);
    points(raw.before).push(...first);
    const shuffled = result(raw);
    expect(shuffled).toMatchObject({ status: 'INDETERMINATE', K: 910n, E: 10n, O: 90n });
    if (!('points' in base) || !('points' in shuffled)) throw new Error('expected points');
    expect(shuffled.points).toEqual(base.points);
  });

  test('increments above safe integers and totals above int64 stay exact', () => {
    const U64 = 18446744073709551615n;
    const raw = pairRaw(
      { ok: '9007199254740993', five: '9223372036854775807', four: '0', ovf: '0' },
      { ok: U64.toString(), five: U64.toString(), four: '0', ovf: '9223372036854775808' },
    );
    const K = U64 - 9007199254740993n + (U64 - 9223372036854775807n);
    const E = U64 - 9223372036854775807n;
    const O = 9223372036854775808n;
    const r = result(raw);
    expect(r).toMatchObject({ K, E, O, T: K + O });
    expect(K + O).toBeGreaterThan(9223372036854775807n);
    if (!('lower' in r) || !r.lower || !r.upper) throw new Error('expected bounds');
    expect(r.lower).toEqual({ numerator: E, denominator: K + O });
    expect(r.upper).toEqual({ numerator: E + O, denominator: K + O });
  });

  test('lossless numeric tokens survive the Worker structured clone', () => {
    const raw = pairRaw(
      { ok: '9007199254740993', five: '7', four: '3', ovf: '5' },
      { ok: '9007199254741793', five: '17', four: '103', ovf: '95' },
    );
    const read = (f: Raw) =>
      structuredClone(normalize(parseOtlp(JSON.stringify(f).replace(/"(\d{16,})"/g, '$1'))))
        .streams[0];
    const before = read(raw.before),
      after = read(raw.after);
    const r = analyzeHttpCumulative(before, after, {
      beforeSnapshotId: before.snapshots[0].id,
      afterSnapshotId: after.snapshots[0].id,
      threshold: '1',
      contractConfirmed: true,
    });
    expect(r).toMatchObject({ K: 910n, E: 10n, O: 90n, T: 1000n });
  });

  test('zero increments are valid; a zero total is no observations, not a rate', () => {
    const quiet = result(pairRaw(BEFORE, { ...AFTER, four: BEFORE.four, ovf: BEFORE.ovf }));
    expect(quiet).toMatchObject({ K: 810n, E: 10n, O: 0n, T: 810n });
    if (!('points' in quiet)) throw new Error('expected points');
    expect(quiet.points.filter((p) => p.count === '0')).toHaveLength(2);
    expect(result(pairRaw(BEFORE, BEFORE))).toMatchObject({
      status: 'NO_DATA',
      T: 0n,
      lower: null,
      upper: null,
    });
    // An overflow-only window and a known-only window are both supported.
    expect(result(pairRaw(BEFORE, { ...BEFORE, ovf: '9' }))).toMatchObject({
      K: 0n,
      O: 4n,
      T: 4n,
      lower: { numerator: 0n, denominator: 4n },
    });
  });
});

describe('cumulative HTTP 5xx windows: applicability', () => {
  test('a changed series start refuses the whole window, even for rising counts', () => {
    const raw = pairRaw();
    point(raw.after, 'ok').startTimeUnixNano = '1500000000';
    expect(result(raw)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'CHANGED_START_TIME' },
    });
    // A restarted SDK that served more than before the window changes every start.
    const restart = pairRaw();
    for (const p of points(restart.after)) p.startTimeUnixNano = '2500000000';
    expect(code(result(restart))).toBe('CHANGED_START_TIME');
  });

  test('distinct per-series starts are allowed when unchanged', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after]) point(f, 'five').startTimeUnixNano = '1500000000';
    expect(result(raw)).toMatchObject({ T: 1000n });
  });

  test.each([
    ['zero', '0', 'INVALID_INTERVAL'],
    ['not before collection', '2000000000', 'INVALID_INTERVAL'],
    ['missing', undefined, 'MISSING_TIMESTAMP'],
  ] as const)('an unusable %s start is refused', (_name, start, expected) => {
    const raw = pairRaw();
    Object.assign(point(raw.before, 'ok'), { startTimeUnixNano: start });
    expect(code(result(raw))).toBe(expected);
  });

  test('a decreasing count refuses even when the total rises', () => {
    const raw = pairRaw();
    point(raw.after, 'five').count = '6';
    point(raw.after, 'five').bucketCounts = ['6', '0'];
    expect(result(raw)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'DECREASING_POINT' },
    });
  });

  test.each(['before', 'after'] as const)('a series missing in %s is never zero-filled', (side) => {
    const raw = pairRaw();
    points(raw[side]).splice(1, 1);
    expect(result(raw)).toMatchObject({ diagnostic: { code: 'MISSING_COUNTERPART' } });
  });

  test('a new series, or overflow in only one export, is not intersected away', () => {
    const extra = pairRaw();
    points(extra.after).push({
      ...structuredClone(point(extra.after, 'ok')),
      attributes: [
        { key: 'test.id', value: { stringValue: 'new' } },
        { key: 'http.response.status_code', value: { intValue: '500' } },
      ],
    });
    expect(code(result(extra))).toBe('MISSING_COUNTERPART');
    const noOverflowBefore = pairRaw();
    points(noOverflowBefore.before).pop();
    expect(code(result(noOverflowBefore))).toBe('MISSING_COUNTERPART');
  });

  test.each(['equal', 'reversed'] as const)('%s collection boundaries are refused', (kind) => {
    const raw = pairRaw();
    for (const p of points(raw.after))
      p.timeUnixNano = kind === 'equal' ? '2000000000' : '1900000000';
    expect(code(result(raw))).toBe('INVALID_WINDOW');
  });

  test('mixed collection timestamps and an unselected boundary are refused', () => {
    const mixed = pairRaw();
    points(mixed.after)[0].timeUnixNano = '3100000000';
    expect(code(result(mixed))).toBe('INCONSISTENT_TIMESTAMPS');
    expect(code(result(pairRaw(), { afterSnapshotId: '' }))).toBe('SNAPSHOT_NOT_SELECTED');
    expect(code(result(pairRaw(), { beforeSnapshotId: '999' }))).toBe('SNAPSHOT_NOT_SELECTED');
  });

  test.each(['resource', 'scope', 'unit', 'resourceSchema', 'scopeSchema'] as const)(
    'a changed %s refuses stream pairing',
    (field) => {
      const raw = pairRaw(),
        rm = raw.after.resourceMetrics[0],
        sm = rm.scopeMetrics[0];
      if (field === 'resource') rm.resource.attributes[0].value.stringValue = 'different';
      if (field === 'scope') sm.scope.version = '2';
      if (field === 'unit') sm.metrics[0].unit = 'ms';
      if (field === 'resourceSchema') Object.assign(rm, { schemaUrl: 'different' });
      if (field === 'scopeSchema') Object.assign(sm, { schemaUrl: 'different' });
      expect(result(raw)).toMatchObject({ diagnostic: { code: 'STREAM_MISMATCH' } });
    },
  );

  test('wrong temporality, type and metric are refused with the side', () => {
    const delta = pairRaw();
    metric(delta.after).histogram.aggregationTemporality = 1;
    expect(result(delta)).toMatchObject({
      diagnostic: { code: 'UNSUPPORTED_TEMPORALITY', path: 'after' },
    });
    const other = pairRaw();
    for (const f of [other.before, other.after]) metric(f).name = 'http.server.request.body.size';
    expect(result(other)).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_METRIC' } });
  });

  test('a description change is not an identity change', () => {
    const raw = pairRaw();
    Object.assign(metric(raw.after), { description: 'changed description' });
    expect(result(raw)).toMatchObject({ T: 1000n });
  });

  test('conflicting definitions of the same metric refuse even if the selected one matches', () => {
    const raw = pairRaw();
    const duplicate = structuredClone(metric(raw.after));
    duplicate.unit = 'ms';
    raw.after.resourceMetrics[0].scopeMetrics[0].metrics.push(duplicate);
    expect(result(raw)).toMatchObject({ diagnostic: { code: 'CONFLICTING_METRIC' } });
  });

  test('delta histogram and Sum windows keep their own refusals', () => {
    const { before, after, options } = imported(pairRaw());
    expect(
      pairCumulative(before, after, { ...options, outcomeAttribute: 'success', errorValue: false }),
    ).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_TEMPORALITY', path: 'before' } });
    const sum = importFixture(fixture()).streams[0];
    expect(
      analyzeCumulative(sum, sum, {
        ...options,
        outcomeAttribute: 'success',
        errorValue: false,
      }),
    ).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_TEMPORALITY' } });
    expect(pairHttpCumulative(sum, sum, options)).toMatchObject({
      diagnostic: { code: 'UNSUPPORTED_TYPE' },
    });
    const delta = importFixture(httpFixture([{ status: 200 }])).streams[0];
    expect(pairHttpCumulative(delta, delta, options)).toMatchObject({
      diagnostic: { code: 'UNSUPPORTED_TEMPORALITY' },
    });
    expect(runHttp(delta)).toMatchObject({ K: 1n });
  });
});

describe('cumulative HTTP 5xx windows: histogram points', () => {
  const corruptions: [string, (p: CumulativePoint) => void, string][] = [
    ['bucket sum', (p) => Object.assign(p, { bucketCounts: ['1', '1'] }), 'BUCKET_COUNT_MISMATCH'],
    ['bucket shape', (p) => Object.assign(p, { explicitBounds: [1, 2] }), 'INVALID_BUCKETS'],
    ['bounds order', (p) => Object.assign(p, { explicitBounds: [2, 1] }), 'INVALID_BUCKETS'],
    ['flags', (p) => Object.assign(p, { flags: 1 }), 'UNSUPPORTED_FLAGS'],
    ['count token', (p) => Object.assign(p, { count: '1.5' }), 'INVALID_INTEGER'],
    ['min above max', (p) => void Object.assign(p, { min: 5, max: 1 }), 'INVALID_MIN_MAX'],
  ];
  test.each(corruptions)(
    'a corrupt %s on any point blocks the pair',
    (_name, corrupt, expected) => {
      for (const side of ['before', 'after'] as const)
        for (const id of ['ok', 'ovf']) {
          const raw = pairRaw();
          corrupt(point(raw[side], id));
          const r = result(raw);
          expect(r).toMatchObject({ diagnostic: { code: expected } });
          expect('K' in r).toBe(false);
          if ('diagnostic' in r) expect(r.diagnostic.path).toMatch(new RegExp(`^${side}\\.`));
        }
    },
  );

  test('a corrupt point of a zero-count series still blocks', () => {
    const raw = pairRaw({ ...BEFORE, four: '0' }, { ...AFTER, four: '0' });
    point(raw.after, 'four').bucketCounts = ['1', '0'];
    expect(code(result(raw))).toBe('BUCKET_COUNT_MISMATCH');
  });

  test('a corrupt point in an unrelated histogram does not block the pair', () => {
    const raw = pairRaw();
    const sm = raw.after.resourceMetrics[0].scopeMetrics[0];
    const unrelated = { ...structuredClone(sm.metrics[0]), name: 'http.server.request.body.size' };
    unrelated.histogram.dataPoints[0].flags = 1;
    sm.metrics.push(unrelated);
    const data = importFixture(raw.after);
    expect(data.streams.map((s) => s.diagnostics.length)).toEqual([0, 1]);
    expect(code(result(raw))).toBe('INDETERMINATE');
  });

  test.each(['missing', 'string', 'boolean', 'low', 'high'] as const)(
    'an invalid %s status refuses the window',
    (kind) => {
      const raw = pairRaw();
      for (const f of [raw.before, raw.after]) {
        const a = point(f, 'five').attributes;
        const i = a.findIndex((x) => x.key === 'http.response.status_code');
        if (kind === 'missing') a.splice(i, 1);
        else
          a[i].value =
            kind === 'string'
              ? { stringValue: '500' }
              : kind === 'boolean'
                ? { boolValue: true }
                : { intValue: kind === 'low' ? '99' : '600' };
      }
      expect(code(result(raw))).toBe(
        kind === 'missing' ? 'MISSING_STATUS_CODE' : 'INVALID_STATUS_CODE',
      );
    },
  );

  test('a contradictory error.type refuses the window', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after])
      point(f, 'ok').attributes.push({ key: 'error.type', value: { stringValue: '503' } });
    expect(code(result(raw))).toBe('CONTRADICTORY_STATUS');
  });

  test.each(['duplicate', 'tagging', 'false-marker'] as const)('%s evidence is refused', (kind) => {
    const raw = pairRaw();
    if (kind === 'duplicate') points(raw.after).push(structuredClone(point(raw.after, 'ok')));
    if (kind === 'tagging')
      point(raw.after, 'ovf').attributes.push({
        key: 'http.response.status_code',
        value: { intValue: '500' },
      });
    if (kind === 'false-marker')
      point(raw.after, 'ovf').attributes[0] = {
        key: 'otel.metric.overflow',
        value: { boolValue: false },
      };
    expect(code(result(raw))).toBe(
      {
        duplicate: 'DUPLICATE_POINT',
        tagging: 'AMBIGUOUS_OVERFLOW',
        'false-marker': 'INVALID_OVERFLOW_MARKER',
      }[kind],
    );
  });

  test('sum, min, max, exemplars and the sum decreasing do not affect applicability', () => {
    const raw = pairRaw();
    for (const p of points(raw.before)) Object.assign(p, { sum: 100, min: 0.1, max: 9 });
    for (const p of points(raw.after))
      Object.assign(p, { sum: -5, min: 0.2, max: 3, exemplars: [{ asDouble: 1 }] });
    expect(result(raw)).toMatchObject({ K: 910n, E: 10n, O: 90n });
  });

  test('changed bucket boundaries or presence under an unchanged start are refused', () => {
    const bounds = pairRaw();
    point(bounds.after, 'five').explicitBounds = [2];
    expect(result(bounds)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'CHANGED_BUCKET_LAYOUT' },
    });
    const dropped = pairRaw();
    Object.assign(point(dropped.after, 'ok'), { bucketCounts: [], explicitBounds: [] });
    expect(code(result(dropped))).toBe('CHANGED_BUCKET_LAYOUT');
    // A changed start is reported first: that is the recorded reset.
    const reset = pairRaw();
    point(reset.after, 'five').explicitBounds = [2];
    point(reset.after, 'five').startTimeUnixNano = '1500000000';
    expect(code(result(reset))).toBe('CHANGED_START_TIME');
  });

  test('a shrinking bucket under a rising total is a hidden reset', () => {
    const raw = pairRaw();
    point(raw.before, 'ok').bucketCounts = ['100', '0'];
    point(raw.after, 'ok').bucketCounts = ['0', '900'];
    expect(result(raw)).toMatchObject({ diagnostic: { code: 'DECREASING_BUCKET' } });
  });
});

describe('cumulative HTTP 5xx windows: preparation, provenance and reports', () => {
  test('threshold and confirmation reuse the prepared counts without re-pairing', () => {
    const { before, after, options } = imported(pairRaw());
    const prepared = pairHttpCumulative(before, after, options);
    if (prepared.status !== 'APPLICABLE') throw new Error('expected an applicable pair');
    expect(prepared.evidence.counts).toEqual({ K: 910n, E: 10n, O: 90n, T: 1000n });
    const same = [
      calculateHttpCumulative(prepared, { threshold: '10', contractConfirmed: true }),
      calculateHttpCumulative(prepared, { threshold: '0.99', contractConfirmed: true }),
      calculateHttpCumulative(prepared, { threshold: '1', contractConfirmed: true }),
    ];
    expect(same.map((r) => r.status)).toEqual(['WITHIN_LIMIT', 'EXCEEDS_LIMIT', 'INDETERMINATE']);
    for (const r of same) {
      if (!('evidence' in r)) throw new Error('expected evidence');
      expect(r.evidence).toBe(prepared.evidence);
      expect(r.points).toBe(prepared.evidence.points);
    }
    expect(
      calculateHttpCumulative(prepared, { threshold: '1', contractConfirmed: false }),
    ).toMatchObject({ diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' } });
    expect(
      calculateHttpCumulative(prepared, { threshold: 'x', contractConfirmed: true }),
    ).toMatchObject({ diagnostic: { code: 'INVALID_THRESHOLD' } });
    expect(prepared.evidence.counts).toEqual({ K: 910n, E: 10n, O: 90n, T: 1000n });
  });

  test('a refused pair cannot become a calculation by changing threshold or confirmation', () => {
    const raw = pairRaw();
    point(raw.after, 'five').startTimeUnixNano = '1500000000';
    const { before, after, options } = imported(raw);
    const prepared = pairHttpCumulative(before, after, options);
    expect(
      calculateHttpCumulative(prepared, { threshold: '100', contractConfirmed: true }),
    ).toEqual(prepared);
    expect(
      calculateHttpCumulative(prepared, { threshold: '100', contractConfirmed: false }),
    ).toEqual(prepared);
  });

  test('structure is checked before confirmation without inventing a verdict', () => {
    const { before, after, options } = imported(pairRaw());
    expect(pairHttpCumulative(before, after, options).status).toBe('APPLICABLE');
    expect(
      analyzeHttpCumulative(before, after, { ...options, contractConfirmed: false }),
    ).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' },
    });
  });

  test('the confirmation covers history, statuses and downstream counts and attribution', () => {
    expect(HTTP_CUMULATIVE_CONTRACT).toContain('one continuous source history');
    expect(HTTP_CUMULATIVE_CONTRACT).toContain('retain the correct http.response.status_code');
    expect(HTTP_CUMULATIVE_CONTRACT).toContain('changed neither counts nor attribution');
  });

  test('report records hashes, identities, boundaries, counts, classification and bounds', () => {
    const { before, after, options } = imported(pairRaw());
    const r = JSON.parse(
      makeHttpCumulativeReport(
        before,
        after,
        options,
        analyzeHttpCumulative(before, after, options),
        sources,
      ),
    );
    expect(r).toMatchObject({
      reportVersion: '4',
      mode: 'http-5xx-histogram-cumulative',
      sources,
      window: { startTimeUnixNano: '2000000000', timeUnixNano: '3000000000' },
      classification: { criterion: 'HTTP 5xx', attribute: 'http.response.status_code' },
      assumptions: { userConfirmed: true, structurallyProven: false },
      applicability: { status: 'APPLICABLE', matchedPointCount: 4 },
      result: {
        status: 'INDETERMINATE',
        K: '910',
        E: '10',
        O: '90',
        T: '1000',
        lower: { numerator: '10', denominator: '1000' },
        upper: { numerator: '100', denominator: '1000' },
      },
      witnesses: { upper: { overflowServerErrors: '90' } },
      counts: {
        atBeforeBoundary: {
          knownRequests: '110',
          knownServerErrors: '7',
          overflow: '5',
          total: '115',
        },
        atAfterBoundary: {
          knownRequests: '1020',
          knownServerErrors: '17',
          overflow: '95',
          total: '1115',
        },
        window: { knownRequests: '910', knownServerErrors: '10', overflow: '90', total: '1000' },
      },
    });
    expect(r.selectedInputs.before).toMatchObject({
      snapshotId: '2000000000',
      timeUnixNano: '2000000000',
    });
    expect(r.selectedInputs.after.identity.name).toBe('http.server.request.duration');
    expect(r.assumptions.conditions.join(' ')).toContain('continuous source history');
    expect(r.applicability.checks.join(' ')).toContain('bucket boundaries');
    expect(r.result.evidence).toBeUndefined();
    for (const p of r.result.points) {
      expect(BigInt(p.afterCount) - BigInt(p.beforeCount)).toBe(BigInt(p.count));
      expect(p.startTimeUnixNano).toBe('1000000000');
    }
    expect(r.result.points.map((p: { responseClass?: string }) => p.responseClass)).toContain(
      'server_error',
    );
  });

  test('report is deterministic across reordered points and attribute keys', () => {
    const report = (raw: ReturnType<typeof pairRaw>) => {
      const { before, after, options } = imported(raw);
      return makeHttpCumulativeReport(
        before,
        after,
        options,
        analyzeHttpCumulative(before, after, options),
        sources,
      );
    };
    const raw = pairRaw();
    const first = report(raw);
    for (const f of [raw.before, raw.after]) {
      points(f).reverse();
      for (const p of points(f)) p.attributes.reverse();
    }
    expect(report(raw)).toBe(first);
  });

  test('a refusal keeps both sources and identities without invented totals', () => {
    const raw = pairRaw();
    point(raw.after, 'five').startTimeUnixNano = '1500000000';
    const { before, after, options } = imported(raw);
    const r = JSON.parse(
      makeHttpCumulativeReport(
        before,
        after,
        options,
        analyzeHttpCumulative(before, after, options),
        sources,
      ),
    );
    expect(r.result.diagnostic.code).toBe('CHANGED_START_TIME');
    expect(r.applicability.diagnostic.code).toBe('CHANGED_START_TIME');
    expect(r.result.T).toBeUndefined();
    expect(r.counts).toBeNull();
    expect(r.witnesses).toBeNull();
    expect(r.sources).toEqual(sources);
    expect(r.selectedInputs.after.identity.name).toBe('http.server.request.duration');
  });

  test.each([
    ['unconfirmed provenance', { contractConfirmed: false }, 'PROVENANCE_NOT_CONFIRMED'],
    ['an invalid threshold', { threshold: 'x' }, 'INVALID_THRESHOLD'],
  ])('a refusal for %s exports no counts, points or witnesses', (_name, overrides, expected) => {
    const { before, after, options } = imported(pairRaw());
    const s = { ...options, ...overrides };
    const r = JSON.parse(
      makeHttpCumulativeReport(before, after, s, analyzeHttpCumulative(before, after, s), sources),
    );
    expect(r.applicability.status).toBe('APPLICABLE');
    expect(r.result.diagnostic.code).toBe(expected);
    expect(r.counts).toBeNull();
    expect(r.witnesses).toBeNull();
    expect(r.result.points).toBeUndefined();
    expect(r.sources).toEqual(sources);
  });

  test('an attribute named evidence is preserved in exported matched identities', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after])
      point(f, 'ok').attributes.push({ key: 'evidence', value: { boolValue: true } });
    const { before, after, options } = imported(raw);
    const r = JSON.parse(
      makeHttpCumulativeReport(
        before,
        after,
        options,
        analyzeHttpCumulative(before, after, options),
        sources,
      ),
    );
    expect(
      r.result.points.find((p: { statusCode?: string }) => p.statusCode === '200').attributes
        .evidence,
    ).toBe(true);
  });
});
