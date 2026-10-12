import { readPoint } from './analyze';
import { calculate, thresholdPercent } from './calculate';
import { canonical, integer } from './parse';
import { type Analysis, type Counts, diagnostic, fail, OVERFLOW, type Stream } from './types';

export type CumulativeSettings = {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  outcomeAttribute: string;
  errorValue: boolean;
  threshold: string;
  contractConfirmed: boolean;
};
export type MatchedPoint = ReturnType<typeof readPoint> & {
  startTimeUnixNano: string;
  beforeCount: string;
  afterCount: string;
};
export type CumulativeSelection = Pick<
  CumulativeSettings,
  'beforeSnapshotId' | 'afterSnapshotId' | 'outcomeAttribute' | 'errorValue'
>;
export type PairEvidence = {
  window: { startTimeUnixNano: string; timeUnixNano: string };
  checks: string[];
  points: MatchedPoint[];
  counts: Counts;
};
type Refusal = Extract<Analysis, { diagnostic: unknown }>;
export type Pairing = { status: 'APPLICABLE'; evidence: PairEvidence } | Refusal;
export type CumulativeAnalysis =
  | Refusal
  | (Omit<Extract<Analysis, { K: bigint }>, 'points'> & {
      points: MatchedPoint[];
      evidence: PairEvidence;
    });

// This is a saved-snapshot applicability check, not a general temporality converter.
export function pairCumulative(
  before: Stream,
  after: Stream,
  settings: CumulativeSelection,
): Pairing {
  try {
    for (const [side, stream] of [
      ['before', before],
      ['after', after],
    ] as const) {
      if (stream.diagnostics.length) {
        const d = stream.diagnostics[0];
        return { status: d.status, diagnostic: { ...d, path: `${side}.${d.path ?? 'stream'}` } };
      }
      if (
        stream.identity.type !== 'sum' ||
        !stream.identity.monotonic ||
        stream.identity.temporality !== 'CUMULATIVE'
      )
        fail(
          'UNSUPPORTED_TEMPORALITY',
          'Cumulative mode requires two monotonic cumulative Sum streams.',
          side,
          'UNSUPPORTED_INPUT',
        );
      if (stream.snapshots.length !== 1)
        fail(
          'INCONSISTENT_TIMESTAMPS',
          'Each selected stream must have exactly one complete collection timestamp.',
          side,
          'UNSUPPORTED_INPUT',
        );
    }
    if (canonical(before.identity) !== canonical(after.identity))
      fail(
        'STREAM_MISMATCH',
        'Resource, scope, schema URLs and metric definition must match on both sides.',
        'pair.identity',
        'UNSUPPORTED_INPUT',
      );
    const b = before.snapshots.find((s) => s.id === settings.beforeSnapshotId);
    const a = after.snapshots.find((s) => s.id === settings.afterSnapshotId);
    if (!b || !a)
      fail(
        'SNAPSHOT_NOT_SELECTED',
        'Select both collection boundaries.',
        'pair.snapshots',
        'UNSUPPORTED_INPUT',
      );
    const start = integer(b.end, 'before.timeUnixNano', true);
    const end = integer(a.end, 'after.timeUnixNano', true);
    if (start <= 0n || end <= start)
      fail(
        'INVALID_WINDOW',
        'The before collection timestamp must be positive and strictly earlier than after.',
        'pair.window',
        'UNSUPPORTED_INPUT',
      );
    if (!settings.outcomeAttribute || settings.outcomeAttribute === OVERFLOW)
      fail(
        'INVALID_OUTCOME_ATTRIBUTE',
        'Choose a boolean measurement outcome attribute other than the overflow marker.',
      );
    const index = (snapshot: typeof b, side: string) => {
      const map = new Map<string, { point: MatchedPoint; start: bigint }>();
      for (const [i, raw] of snapshot.points.entries()) {
        const path = `${side}.points[${i}]`;
        const p = readPoint(raw, settings.outcomeAttribute, path);
        const key = canonical(p.attributes);
        if (map.has(key))
          fail(
            'DUPLICATE_POINT',
            'Repeated measurement identity makes the snapshot ambiguous.',
            path,
          );
        const t = integer(raw.startTimeUnixNano, `${path}.startTimeUnixNano`, true);
        const collection = integer(raw.timeUnixNano, `${path}.timeUnixNano`, true);
        if (t <= 0n || t >= collection)
          fail('INVALID_INTERVAL', 'Require a known start time with 0 < start < collection.', path);
        if (collection.toString() !== snapshot.end)
          fail(
            'INCONSISTENT_TIMESTAMPS',
            'Point timestamp differs from the selected collection.',
            path,
            'UNSUPPORTED_INPUT',
          );
        map.set(key, {
          start: t,
          point: { ...p, startTimeUnixNano: t.toString(), beforeCount: '', afterCount: '' },
        });
      }
      if (!map.size) fail('MISSING_INTERVAL', 'A snapshot must contain timestamped points.', side);
      return map;
    };
    const bm = index(b, 'before'),
      am = index(a, 'after');
    for (const key of new Set([...bm.keys(), ...am.keys()]))
      if (!bm.has(key) || !am.has(key))
        fail(
          'MISSING_COUNTERPART',
          `Measurement identity is missing in ${bm.has(key) ? 'after' : 'before'}; changing series are unsupported.`,
          `pair.attributes.${key}`,
          'UNSUPPORTED_INPUT',
        );
    const points: MatchedPoint[] = [];
    let K = 0n,
      E = 0n,
      O = 0n;
    for (const key of [...bm.keys()].sort()) {
      const bp = bm.get(key),
        ap = am.get(key);
      if (!bp || !ap) throw new Error('Missing matched point');
      if (bp.start !== ap.start)
        fail(
          'CHANGED_START_TIME',
          `Matched series changed start time from ${bp.start} to ${ap.start}; continuity is not established.`,
          `pair.attributes.${key}`,
          'UNSUPPORTED_INPUT',
        );
      if (bp.start >= start)
        fail(
          'INVALID_SERIES_START',
          'A matched series must start before the window.',
          `pair.attributes.${key}`,
          'UNSUPPORTED_INPUT',
        );
      const increment = BigInt(ap.point.count) - BigInt(bp.point.count);
      if (increment < 0n)
        fail(
          'DECREASING_POINT',
          `Matched counter decreased from ${bp.point.count} to ${ap.point.count}.`,
          `pair.attributes.${key}`,
          'UNSUPPORTED_INPUT',
        );
      points.push({
        ...bp.point,
        beforeCount: bp.point.count,
        afterCount: ap.point.count,
        count: increment.toString(),
      });
      if (bp.point.overflow) O += increment;
      else {
        K += increment;
        if (bp.point.attributes[settings.outcomeAttribute] === settings.errorValue) E += increment;
      }
    }
    return {
      status: 'APPLICABLE',
      evidence: {
        window: { startTimeUnixNano: start.toString(), timeUnixNano: end.toString() },
        checks: [
          'identical stream definition',
          'one collection timestamp per export',
          'strictly ordered collection timestamps',
          'equal unique measurement identity sets',
          'known unchanged per-series start times before window',
          'nondecreasing integer counts per point',
          'valid flags, boolean outcomes and SDK overflow shape',
        ],
        points,
        counts: { K, E, O, T: K + O },
      },
    };
  } catch (error) {
    const d = diagnostic(error);
    return { status: d.status, diagnostic: d };
  }
}

export function analyzeCumulative(
  before: Stream,
  after: Stream,
  settings: CumulativeSettings,
): CumulativeAnalysis {
  return calculateCumulative(pairCumulative(before, after, settings), settings);
}

// Reuse a validated selection when only the threshold or provenance confirmation changes.
export function calculateCumulative(
  pair: Pairing,
  settings: Pick<CumulativeSettings, 'threshold' | 'contractConfirmed'>,
): CumulativeAnalysis {
  if (pair.status !== 'APPLICABLE') return pair;
  try {
    if (!settings.contractConfirmed)
      fail(
        'PROVENANCE_NOT_CONFIRMED',
        'Confirm both complete SDK exports, continuous source history, stable attribution and one boolean outcome per request. Structure cannot prove these assumptions.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    const { K, E, O } = pair.evidence.counts;
    return {
      ...calculate(K, E, O, thresholdPercent(settings.threshold)),
      points: pair.evidence.points,
      evidence: pair.evidence,
    };
  } catch (error) {
    const d = diagnostic(error);
    return { status: d.status, diagnostic: d };
  }
}
