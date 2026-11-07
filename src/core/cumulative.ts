import { readPoint } from './analyze';
import { calculate, thresholdPercent } from './calculate';
import { canonical, integer } from './parse';
import {
  type Analysis,
  type Attributes,
  type Counts,
  diagnostic,
  fail,
  type Identity,
  type ObjectValue,
  OVERFLOW,
  type Stream,
} from './types';

export type CumulativeSettings = {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  outcomeAttribute: string;
  errorValue: boolean;
  threshold: string;
  contractConfirmed: boolean;
};
// One counted point. The HTTP histogram window adds the status classification.
export type PointRead = {
  attributes: Attributes;
  count: string;
  overflow: boolean;
  statusCode?: string;
  responseClass?: 'server_error' | 'other';
};
export type MatchedPoint = PointRead & {
  startTimeUnixNano: string;
  beforeCount: string;
  afterCount: string;
};
export type WindowBoundaries = Pick<CumulativeSettings, 'beforeSnapshotId' | 'afterSnapshotId'>;
export type CumulativeSelection = WindowBoundaries &
  Pick<CumulativeSettings, 'outcomeAttribute' | 'errorValue'>;
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

// What differs between cumulative windows of different metrics. Everything else
// (identity, boundaries, series matching, continuity, exact increments) is shared.
export type WindowProfile<X = undefined> = {
  checks: string[];
  // Refuses a stream that is not the supported cumulative definition.
  stream(identity: Identity, side: string): void;
  // Refuses an unusable classification choice before any point is read.
  selection(): void;
  // Wire validation and classification of one raw point; `evidence` is kept per series.
  read(raw: ObjectValue, path: string): { point: PointRead; evidence: X };
  isError(point: PointRead): boolean;
  // Extra per-series evidence that the two points belong to one continuous history.
  continuity(before: X, after: X, path: string): void;
};

export function pairWindow<X>(
  before: Stream,
  after: Stream,
  boundaries: WindowBoundaries,
  profile: WindowProfile<X>,
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
      profile.stream(stream.identity, side);
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
    const b = before.snapshots.find((s) => s.id === boundaries.beforeSnapshotId);
    const a = after.snapshots.find((s) => s.id === boundaries.afterSnapshotId);
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
    profile.selection();
    const index = (snapshot: typeof b, side: string) => {
      const map = new Map<string, { point: PointRead; evidence: X; start: bigint }>();
      for (const [i, raw] of snapshot.points.entries()) {
        const path = `${side}.points[${i}]`;
        const { point, evidence } = profile.read(raw, path);
        const key = canonical(point.attributes);
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
        map.set(key, { start: t, evidence, point });
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
      const path = `pair.attributes.${key}`;
      if (bp.start !== ap.start)
        fail(
          'CHANGED_START_TIME',
          `Matched series changed start time from ${bp.start} to ${ap.start}; continuity is not established.`,
          path,
          'UNSUPPORTED_INPUT',
        );
      if (bp.start >= start)
        fail(
          'INVALID_SERIES_START',
          'A matched series must start before the window.',
          path,
          'UNSUPPORTED_INPUT',
        );
      const increment = BigInt(ap.point.count) - BigInt(bp.point.count);
      if (increment < 0n)
        fail(
          'DECREASING_POINT',
          `Matched counter decreased from ${bp.point.count} to ${ap.point.count}.`,
          path,
          'UNSUPPORTED_INPUT',
        );
      profile.continuity(bp.evidence, ap.evidence, path);
      points.push({
        ...bp.point,
        startTimeUnixNano: bp.start.toString(),
        beforeCount: bp.point.count,
        afterCount: ap.point.count,
        count: increment.toString(),
      });
      if (bp.point.overflow) O += increment;
      else {
        K += increment;
        if (profile.isError(bp.point)) E += increment;
      }
    }
    return {
      status: 'APPLICABLE',
      evidence: {
        window: { startTimeUnixNano: start.toString(), timeUnixNano: end.toString() },
        checks: profile.checks,
        points,
        counts: { K, E, O, T: K + O },
      },
    };
  } catch (error) {
    const d = diagnostic(error);
    return { status: d.status, diagnostic: d };
  }
}

// Reuse a validated selection when only the threshold or provenance confirmation changes.
export function calculateWindow(
  pair: Pairing,
  settings: Pick<CumulativeSettings, 'threshold' | 'contractConfirmed'>,
  unconfirmed: string,
): CumulativeAnalysis {
  if (pair.status !== 'APPLICABLE') return pair;
  try {
    if (!settings.contractConfirmed)
      fail('PROVENANCE_NOT_CONFIRMED', unconfirmed, undefined, 'UNSUPPORTED_INPUT');
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

function sumProfile(settings: CumulativeSelection): WindowProfile {
  return {
    checks: [
      'identical stream definition',
      'one collection timestamp per export',
      'strictly ordered collection timestamps',
      'equal unique measurement identity sets',
      'known unchanged per-series start times before window',
      'nondecreasing integer counts per point',
      'valid flags, boolean outcomes and SDK overflow shape',
    ],
    stream(identity, side) {
      if (identity.type !== 'sum' || !identity.monotonic || identity.temporality !== 'CUMULATIVE')
        fail(
          'UNSUPPORTED_TEMPORALITY',
          'Cumulative mode requires two monotonic cumulative Sum streams.',
          side,
          'UNSUPPORTED_INPUT',
        );
    },
    selection() {
      if (!settings.outcomeAttribute || settings.outcomeAttribute === OVERFLOW)
        fail(
          'INVALID_OUTCOME_ATTRIBUTE',
          'Choose a boolean measurement outcome attribute other than the overflow marker.',
        );
    },
    read: (raw, path) => ({
      point: readPoint(raw, settings.outcomeAttribute, path),
      evidence: undefined,
    }),
    isError: (point) => point.attributes[settings.outcomeAttribute] === settings.errorValue,
    continuity() {},
  };
}

// This is a saved-snapshot applicability check, not a general temporality converter.
export function pairCumulative(
  before: Stream,
  after: Stream,
  settings: CumulativeSelection,
): Pairing {
  return pairWindow(before, after, settings, sumProfile(settings));
}

export function analyzeCumulative(
  before: Stream,
  after: Stream,
  settings: CumulativeSettings,
): CumulativeAnalysis {
  return calculateCumulative(pairCumulative(before, after, settings), settings);
}

export function calculateCumulative(
  pair: Pairing,
  settings: Pick<CumulativeSettings, 'threshold' | 'contractConfirmed'>,
): CumulativeAnalysis {
  return calculateWindow(
    pair,
    settings,
    'Confirm both complete SDK exports, continuous source history, stable attribution and one boolean outcome per request. Structure cannot prove these assumptions.',
  );
}
