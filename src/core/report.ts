import type { Settings } from './analyze';
import { type CumulativeSettings, pairCumulative } from './cumulative';
import { canonical } from './parse';
import { type Analysis, CONTRACT, CUMULATIVE_CONTRACT, type Stream } from './types';
export type Source = { name: string; sha256: string; bytes: number };
export function makeReport(stream: Stream, settings: Settings, result: Analysis, source: Source) {
  const interval = stream.intervals.find((i) => i.id === settings.intervalId);
  const report = {
    reportVersion: '1',
    application: { name: 'OverflowLens', version: '0.2.0' },
    source,
    identity: stream.identity,
    interval: interval ? { startTimeUnixNano: interval.start, timeUnixNano: interval.end } : null,
    settings,
    assumptions: {
      contract: CONTRACT,
      userConfirmed: settings.contractConfirmed,
      structurallyProven: false,
    },
    model: {
      K: 'sum of ordinary points',
      E: 'sum of ordinary error points',
      O: 'SDK overflow count',
      T: 'K + O',
      lower: 'E / T',
      upper: '(E + O) / T',
      within: 'upper <= threshold',
      exceeds: 'lower > threshold',
      equalityAllowed: true,
    },
    result,
    witnesses:
      'lower' in result && result.T > 0n
        ? {
            lower: { overflowErrors: '0', overflowSuccesses: result.O.toString() },
            upper: { overflowErrors: result.O.toString(), overflowSuccesses: '0' },
          }
        : null,
    limitations: [
      'One imported interval, not a full SLO assessment.',
      'The file cannot prove completeness, synchronous instrumentation or pre-transformation SDK provenance.',
      'Bounds describe possible allocations, not a confidence interval or recovered attributes.',
    ],
  };
  return JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

export function makeCumulativeReport(
  before: Stream,
  after: Stream,
  settings: CumulativeSettings,
  result: Analysis,
  sources: { before: Source; after: Source },
) {
  const pair = pairCumulative(before, after, settings);
  const b = before.snapshots.find((s) => s.id === settings.beforeSnapshotId);
  const a = after.snapshots.find((s) => s.id === settings.afterSnapshotId);
  // Canonicalize key order as well as matched-point order for repeatable evidence.
  return JSON.stringify(
    JSON.parse(
      canonical({
        reportVersion: '2',
        application: { name: 'OverflowLens', version: '0.2.0' },
        mode: 'cumulative',
        sources,
        identity: before.identity,
        selectedInputs: {
          before: {
            identity: before.identity,
            snapshotId: settings.beforeSnapshotId,
            timeUnixNano: b?.end ?? null,
          },
          after: {
            identity: after.identity,
            snapshotId: settings.afterSnapshotId,
            timeUnixNano: a?.end ?? null,
          },
        },
        window: b && a ? { startTimeUnixNano: b.end, timeUnixNano: a.end } : null,
        settings,
        assumptions: {
          contract: CUMULATIVE_CONTRACT,
          userConfirmed: settings.contractConfirmed,
          structurallyProven: false,
        },
        applicability:
          pair.status === 'APPLICABLE'
            ? {
                status: pair.status,
                checks: pair.evidence.checks,
                matchedPointCount: pair.evidence.points.length,
              }
            : pair,
        model: {
          increment: 'count(after) - count(before), for each matched point',
          K: 'sum of ordinary increments',
          E: 'sum of ordinary error increments',
          O: 'SDK overflow increment',
          T: 'K + O',
          lower: 'E / T',
          upper: '(E + O) / T',
          within: 'upper <= threshold',
          exceeds: 'lower > threshold',
          equalityAllowed: true,
        },
        result: JSON.parse(
          JSON.stringify({ ...result, evidence: undefined }, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
        witnesses:
          'K' in result && result.T > 0n
            ? {
                lower: { overflowErrors: '0', overflowSuccesses: result.O.toString() },
                upper: { overflowErrors: result.O.toString(), overflowSuccesses: '0' },
              }
            : null,
        limitations: [
          'One saved cumulative window, identical measurement identities only; no reset handling.',
          'Hashes identify bytes, not authenticity, completeness or continuous source history.',
          'Endpoint witnesses allocate window overflow increments; exemplars cannot recover all outcomes.',
        ],
      }),
    ),
    null,
    2,
  );
}
