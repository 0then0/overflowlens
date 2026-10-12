import { describe, expect, test } from 'vitest';
import {
  analyzeCumulative,
  type CumulativeSettings,
  calculateCumulative,
  pairCumulative,
} from '../src/core/cumulative';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { makeCumulativeReport, makeReport } from '../src/core/report';
import type { Stream } from '../src/core/types';
import { fixture, importFixture, run } from './helpers';

function cumulativeRaw(
  success = '100',
  error = '7',
  overflow: string | null = '5',
  end = '2000000000',
) {
  const f = fixture(success, error, overflow);
  const s = f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
  s.aggregationTemporality = 2;
  for (const p of s.dataPoints) p.timeUnixNano = end;
  return f;
}
const sum = (f: ReturnType<typeof fixture>) => f.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
function settings(
  before: Stream,
  after: Stream,
  overrides: Partial<CumulativeSettings> = {},
): CumulativeSettings {
  return {
    beforeSnapshotId: before.snapshots[0]?.id ?? '',
    afterSnapshotId: after.snapshots[0]?.id ?? '',
    outcomeAttribute: 'success',
    errorValue: false,
    threshold: '1',
    contractConfirmed: true,
    ...overrides,
  };
}
function pairRaw() {
  return { before: cumulativeRaw(), after: cumulativeRaw('1000', '8', '104', '3000000000') };
}
function imported(raw: ReturnType<typeof pairRaw>) {
  const before = structuredClone(importFixture(raw.before)).streams[0],
    after = structuredClone(importFixture(raw.after)).streams[0];
  return { before, after, options: settings(before, after) };
}
function result(raw = pairRaw(), overrides: Partial<CumulativeSettings> = {}) {
  const { before, after, options } = imported(raw);
  return analyzeCumulative(before, after, { ...options, ...overrides });
}
const sources = {
  before: { name: 'before.json', sha256: 'a'.repeat(64), bytes: 10 },
  after: { name: 'after.json', sha256: 'b'.repeat(64), bytes: 20 },
};

describe('saved cumulative windows (synthetic contract controls)', () => {
  test('nonzero baseline is excluded and exact upper equality is within', () => {
    const r = result(pairRaw(), { threshold: '10' });
    expect(r).toMatchObject({
      status: 'WITHIN_LIMIT',
      K: 901n,
      E: 1n,
      O: 99n,
      T: 1000n,
      lower: { numerator: 1n, denominator: 1000n },
      upper: { numerator: 100n, denominator: 1000n },
    });
    expect(result(pairRaw(), { threshold: '0.1' }).status).toBe('INDETERMINATE');
    expect(result(pairRaw(), { threshold: '0.09999999999999999999' }).status).toBe('EXCEEDS_LIMIT');
  });
  test('lossless numeric counts and timestamps survive Worker structured clone', () => {
    const raw = pairRaw();
    const end = '18000000000000000000';
    for (const [f, t] of [
      [raw.before, end],
      [raw.after, '18000000000000000001'],
    ] as const)
      for (const p of sum(f).dataPoints) {
        p.startTimeUnixNano = '17000000000000000000';
        p.timeUnixNano = t;
      }
    sum(raw.before).dataPoints[0].asInt = '9007199254740993';
    sum(raw.after).dataPoints[0].asInt = '9007199254741893';
    const read = (f: typeof raw.before) =>
      structuredClone(normalize(parseOtlp(JSON.stringify(f).replace(/"(\d{16,})"/g, '$1'))))
        .streams[0];
    const b = read(raw.before),
      a = read(raw.after);
    expect(analyzeCumulative(b, a, settings(b, a))).toMatchObject({
      K: 901n,
      T: 1000n,
      evidence: { window: { startTimeUnixNano: end, timeUnixNano: '18000000000000000001' } },
    });
  });
  test('increments above safe integers and totals above int64 stay exact', () => {
    const raw = {
      before: cumulativeRaw('0', '0', null),
      after: cumulativeRaw('9223372036854775807', '9223372036854775807', null, '3000000000'),
    };
    expect(result(raw, { threshold: '50' })).toMatchObject({
      status: 'WITHIN_LIMIT',
      K: 18446744073709551614n,
      E: 9223372036854775807n,
      T: 18446744073709551614n,
      lower: { numerator: 9223372036854775807n, denominator: 18446744073709551614n },
    });
  });
  test('point decrease blocks a positive overall increment', () => {
    const raw = pairRaw();
    sum(raw.after).dataPoints[1].asInt = '6';
    expect(result(raw)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'DECREASING_POINT' },
    });
  });
  test('distinct per-series starts and reordered attributes match', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after]) {
      sum(f).dataPoints[1].startTimeUnixNano = '1500000000';
      sum(f).dataPoints[0].attributes.push({ key: 'id', value: { stringValue: 'retained' } });
    }
    sum(raw.after).dataPoints.reverse();
    sum(raw.after).dataPoints[2].attributes.reverse();
    expect(result(raw)).toMatchObject({ status: 'INDETERMINATE', T: 1000n });
  });
  test.each(['resource', 'scope', 'name', 'unit', 'resourceSchema', 'scopeSchema'] as const)(
    'changed %s refuses stream pairing',
    (field) => {
      const raw = pairRaw(),
        rm = raw.after.resourceMetrics[0],
        sm = rm.scopeMetrics[0],
        m = sm.metrics[0];
      if (field === 'resource') rm.resource.attributes[0].value.stringValue = 'different';
      if (field === 'scope') sm.scope.version = '2';
      if (field === 'name') m.name = 'other';
      if (field === 'unit') m.unit = 'other';
      if (field === 'resourceSchema') Object.assign(rm, { schemaUrl: 'different' });
      if (field === 'scopeSchema') Object.assign(sm, { schemaUrl: 'different' });
      expect(result(raw)).toMatchObject({ diagnostic: { code: 'STREAM_MISMATCH' } });
    },
  );
  test('description is non-identifying', () => {
    const raw = pairRaw();
    Object.assign(raw.after.resourceMetrics[0].scopeMetrics[0].metrics[0], {
      description: 'changed description',
    });
    expect(result(raw)).toMatchObject({ T: 1000n });
  });
  test('conflicting metric definitions refuse even when selected definition matches', () => {
    const raw = pairRaw(),
      metrics = raw.after.resourceMetrics[0].scopeMetrics[0].metrics;
    const duplicate = structuredClone(metrics[0]);
    duplicate.unit = 'different';
    metrics.push(duplicate);
    expect(result(raw)).toMatchObject({
      status: 'INVALID_INPUT',
      diagnostic: { code: 'CONFLICTING_METRIC' },
    });
  });
  test.each(['delta', 'non-monotonic', 'gauge'] as const)(
    'reject %s on cumulative side',
    (kind) => {
      const raw = pairRaw();
      if (kind === 'delta') sum(raw.after).aggregationTemporality = 1;
      if (kind === 'non-monotonic') sum(raw.after).isMonotonic = false;
      if (kind === 'gauge') {
        const m = raw.after.resourceMetrics[0].scopeMetrics[0].metrics[0];
        Object.assign(m, { sum: undefined, gauge: { dataPoints: [] } });
      }
      expect(result(raw).status).toBe('UNSUPPORTED_INPUT');
    },
  );
  test.each(['before', 'after'] as const)(
    'missing counterpart in %s is never zero-filled',
    (side) => {
      const raw = pairRaw();
      sum(raw[side]).dataPoints.pop();
      expect(result(raw)).toMatchObject({ diagnostic: { code: 'MISSING_COUNTERPART' } });
    },
  );
  test('ordinary extra point refuses instead of intersecting', () => {
    const raw = pairRaw(),
      point = structuredClone(sum(raw.after).dataPoints[0]);
    point.attributes.push({ key: 'new', value: { boolValue: true } });
    sum(raw.after).dataPoints.push(point);
    expect(result(raw)).toMatchObject({ diagnostic: { code: 'MISSING_COUNTERPART' } });
  });
  test.each(['zero', 'missing', 'equal', 'changed'] as const)('reject %s start time', (kind) => {
    const raw = pairRaw(),
      p = sum(raw.after).dataPoints[0];
    if (kind === 'missing') Object.assign(p, { startTimeUnixNano: undefined });
    else
      p.startTimeUnixNano =
        kind === 'zero' ? '0' : kind === 'equal' ? p.timeUnixNano : '1500000000';
    expect(result(raw)).toMatchObject({
      diagnostic: {
        code:
          kind === 'missing'
            ? 'MISSING_TIMESTAMP'
            : kind === 'changed'
              ? 'CHANGED_START_TIME'
              : 'INVALID_INTERVAL',
      },
    });
  });
  test.each(['equal', 'reversed', 'mixed'] as const)('reject %s collection boundaries', (kind) => {
    const raw = pairRaw();
    for (const p of sum(raw.after).dataPoints)
      p.timeUnixNano =
        kind === 'equal' ? '2000000000' : kind === 'reversed' ? '1900000000' : '3000000000';
    if (kind === 'mixed') sum(raw.after).dataPoints[0].timeUnixNano = '3100000000';
    expect(result(raw)).toMatchObject({
      diagnostic: { code: kind === 'mixed' ? 'INCONSISTENT_TIMESTAMPS' : 'INVALID_WINDOW' },
    });
  });
  test('unselected collection boundary does not fall back to an arbitrary snapshot', () => {
    expect(result(pairRaw(), { afterSnapshotId: '' })).toMatchObject({
      diagnostic: { code: 'SNAPSHOT_NOT_SELECTED' },
    });
  });
  test.each(['duplicate', 'tagging', 'false-marker', 'flags', 'double', 'outcome'] as const)(
    'reject %s evidence',
    (kind) => {
      const raw = pairRaw(),
        s = sum(raw.after);
      const codes = {
        duplicate: 'DUPLICATE_POINT',
        tagging: 'AMBIGUOUS_OVERFLOW',
        'false-marker': 'INVALID_OVERFLOW_MARKER',
        flags: 'UNSUPPORTED_FLAGS',
        double: 'DOUBLE_COUNTER',
        outcome: 'NON_BOOLEAN_OUTCOME',
      };
      if (kind === 'duplicate') s.dataPoints.push(structuredClone(s.dataPoints[0]));
      if (kind === 'tagging')
        s.dataPoints[2].attributes.push({ key: 'success', value: { boolValue: true } });
      if (kind === 'false-marker')
        s.dataPoints[2].attributes[0] = {
          key: 'otel.metric.overflow',
          value: { boolValue: false },
        };
      if (kind === 'flags') Object.assign(s.dataPoints[0], { flags: 1 });
      if (kind === 'double') Object.assign(s.dataPoints[0], { asDouble: 1000, asInt: undefined });
      if (kind === 'outcome')
        s.dataPoints[0].attributes[0] = { key: 'success', value: { stringValue: 'true' } };
      expect(result(raw)).toMatchObject({ diagnostic: { code: codes[kind] } });
    },
  );
  test('overflow-only window is supported with explicit outcome', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after]) sum(f).dataPoints.splice(0, 2);
    expect(result(raw)).toMatchObject({ K: 0n, E: 0n, O: 99n, T: 99n });
  });
  test('no increments gives NO_DATA, not a zero rate', () => {
    const raw = pairRaw();
    for (let i = 0; i < 3; i++)
      sum(raw.after).dataPoints[i].asInt = sum(raw.before).dataPoints[i].asInt;
    expect(result(raw)).toMatchObject({ status: 'NO_DATA', T: 0n, lower: null, upper: null });
  });
  test('a prepared window supports exact threshold changes and confirmation without reimporting', () => {
    const { before, after, options } = imported(pairRaw());
    const prepared = pairCumulative(before, after, options);
    if (prepared.status !== 'APPLICABLE') throw new Error('Expected a complete window');
    expect(prepared.evidence.counts).toEqual({ K: 901n, E: 1n, O: 99n, T: 1000n });
    expect(
      calculateCumulative(prepared, { threshold: '10', contractConfirmed: true }),
    ).toMatchObject({ status: 'WITHIN_LIMIT', K: 901n, E: 1n, O: 99n });
    expect(
      calculateCumulative(prepared, {
        threshold: '0.09999999999999999999',
        contractConfirmed: true,
      }),
    ).toMatchObject({ status: 'EXCEEDS_LIMIT', T: 1000n });
    expect(
      calculateCumulative(prepared, { threshold: '1', contractConfirmed: true }),
    ).toMatchObject({ status: 'INDETERMINATE', T: 1000n });
    expect(
      calculateCumulative(prepared, { threshold: '1', contractConfirmed: false }),
    ).toMatchObject({ diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' } });
    expect(
      calculateCumulative(prepared, { threshold: 'invalid', contractConfirmed: true }),
    ).toMatchObject({ diagnostic: { code: 'INVALID_THRESHOLD' } });
    expect(prepared.evidence.counts).toEqual({ K: 901n, E: 1n, O: 99n, T: 1000n });
    const opposite = pairCumulative(before, after, { ...options, errorValue: true });
    expect(calculateCumulative(opposite, options)).toMatchObject({
      E: 900n,
      status: 'EXCEEDS_LIMIT',
    });
  });
  test('prepared refusals cannot become calculations when threshold or confirmation changes', () => {
    const raw = pairRaw();
    sum(raw.after).dataPoints[0].asInt = '99';
    const { before, after, options } = imported(raw);
    const prepared = pairCumulative(before, after, options);
    expect(
      calculateCumulative(prepared, { threshold: '100', contractConfirmed: true }),
    ).toMatchObject({ status: 'UNSUPPORTED_INPUT', diagnostic: { code: 'DECREASING_POINT' } });
    expect(calculateCumulative(prepared, { threshold: '0', contractConfirmed: false })).toEqual(
      prepared,
    );
  });
  test('structural applicability precedes confirmation without inventing a verdict', () => {
    const { before, after, options } = imported(pairRaw());
    options.contractConfirmed = false;
    expect(pairCumulative(before, after, options).status).toBe('APPLICABLE');
    expect(analyzeCumulative(before, after, options)).toMatchObject({
      status: 'UNSUPPORTED_INPUT',
      diagnostic: { code: 'PROVENANCE_NOT_CONFIRMED' },
    });
  });
  test('report records exact increments, both inputs, assumptions and endpoint witnesses', () => {
    const { before, after, options } = imported(pairRaw());
    const r = JSON.parse(
      makeCumulativeReport(
        before,
        after,
        options,
        analyzeCumulative(before, after, options),
        sources,
      ),
    );
    expect(r.reportVersion).toBe('2');
    expect(r.mode).toBe('cumulative');
    expect(r.sources).toEqual(sources);
    expect(r.window).toEqual({ startTimeUnixNano: '2000000000', timeUnixNano: '3000000000' });
    expect(r.assumptions.structurallyProven).toBe(false);
    expect(r.applicability.matchedPointCount).toBe(3);
    expect(r.witnesses.upper.overflowErrors).toBe('99');
    expect(
      r.result.points.reduce(
        (n: bigint, p: { count: string; beforeCount: string; afterCount: string }) => {
          expect(BigInt(p.afterCount) - BigInt(p.beforeCount)).toBe(BigInt(p.count));
          return n + BigInt(p.count);
        },
        0n,
      ),
    ).toBe(1000n);
  });
  test('report is deterministic across reordered points and attribute keys', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after])
      sum(f).dataPoints[0].attributes.push({ key: 'id', value: { stringValue: 'retained' } });
    const report = () => {
      const { before, after, options } = imported(raw);
      return makeCumulativeReport(
        before,
        after,
        options,
        analyzeCumulative(before, after, options),
        sources,
      );
    };
    const first = report();
    for (const f of [raw.before, raw.after]) {
      sum(f).dataPoints[0].attributes.reverse();
      sum(f).dataPoints.reverse();
    }
    expect(report()).toBe(first);
  });
  test('an attribute named evidence is preserved in exported matched identities', () => {
    const raw = pairRaw();
    for (const f of [raw.before, raw.after])
      sum(f).dataPoints[0].attributes.push({ key: 'evidence', value: { boolValue: true } });
    const { before, after, options } = imported(raw);
    const report = JSON.parse(
      makeCumulativeReport(
        before,
        after,
        options,
        analyzeCumulative(before, after, options),
        sources,
      ),
    );
    expect(
      report.result.points.find(
        (p: { attributes: Record<string, unknown> }) => p.attributes.success === true,
      ).attributes.evidence,
    ).toBe(true);
    expect(report.result.evidence).toBeUndefined();
  });
  test('refusal report links a mismatch to both selected identities and hashes', () => {
    const raw = pairRaw();
    raw.after.resourceMetrics[0].scopeMetrics[0].metrics[0].unit = 'other';
    const { before, after, options } = imported(raw);
    const r = JSON.parse(
      makeCumulativeReport(
        before,
        after,
        options,
        analyzeCumulative(before, after, options),
        sources,
      ),
    );
    expect(r.result.diagnostic.code).toBe('STREAM_MISMATCH');
    expect(r.result.T).toBeUndefined();
    expect(r.sources).toEqual(sources);
    expect(r.selectedInputs.after.identity.unit).toBe('other');
    expect(r.witnesses).toBeNull();
  });
  test('delta analysis and schema v1 stay supported and refuse a cumulative single input', () => {
    const stream = importFixture(fixture()).streams[0],
      options = {
        intervalId: stream.intervals[0].id,
        outcomeAttribute: 'success',
        errorValue: false,
        threshold: '1',
        contractConfirmed: true,
      };
    expect(run(stream)).toMatchObject({ status: 'INDETERMINATE', T: 1000n });
    const r = JSON.parse(makeReport(stream, options, run(stream), sources.before));
    expect(r.reportVersion).toBe('1');
    expect(r.source).toEqual(sources.before);
    expect(r.result.T).toBe('1000');
    expect(run(importFixture(cumulativeRaw()).streams[0])).toMatchObject({
      diagnostic: { code: 'UNSUPPORTED_TEMPORALITY' },
    });
  });
});
