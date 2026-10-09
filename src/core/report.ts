import type { Settings } from './analyze';
import { type Analysis, CONTRACT, type Stream } from './types';
export function makeReport(
  stream: Stream,
  settings: Settings,
  result: Analysis,
  source: { name: string; sha256: string; bytes: number },
) {
  const interval = stream.intervals.find((i) => i.id === settings.intervalId);
  const report = {
    reportVersion: '1',
    application: { name: 'OverflowLens', version: '0.1.0' },
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
