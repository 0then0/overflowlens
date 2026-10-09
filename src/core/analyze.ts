import { calculate, thresholdPercent } from './calculate';
import { attributes, canonical, integer } from './parse';
import { type Analysis, diagnostic, fail, OVERFLOW, type Stream } from './types';
export type Settings = {
  intervalId: string;
  outcomeAttribute: string;
  errorValue: boolean;
  threshold: string;
  contractConfirmed: boolean;
};
export function analyze(stream: Stream, settings: Settings): Analysis {
  try {
    if (stream.diagnostics.length)
      return { status: stream.diagnostics[0].status, diagnostic: stream.diagnostics[0] };
    if (!settings.contractConfirmed)
      fail(
        'PROVENANCE_NOT_CONFIRMED',
        'Confirm the data provenance contract. Structural checks cannot establish delivery completeness or measurement origin.',
        undefined,
        'UNSUPPORTED_INPUT',
      );
    const interval = stream.intervals.find((i) => i.id === settings.intervalId);
    if (!interval) fail('INTERVAL_NOT_SELECTED', 'Select one complete collection interval.');
    if (!settings.outcomeAttribute || settings.outcomeAttribute === OVERFLOW)
      fail(
        'INVALID_OUTCOME_ATTRIBUTE',
        'Choose a boolean measurement outcome attribute other than the overflow marker.',
      );
    const threshold = thresholdPercent(settings.threshold);
    let K = 0n,
      E = 0n,
      O = 0n;
    const seen = new Set<string>();
    const points = interval.points.map((p, i) => {
      const path = `selectedInterval.points[${i}]`;
      const attrs = attributes(p.attributes, `${path}.attributes`);
      const key = canonical(attrs);
      if (seen.has(key))
        fail(
          'DUPLICATE_POINT',
          'Repeated measurement attribute sets within one interval are ambiguous or duplicate exports.',
          path,
        );
      seen.add(key);
      if (p.flags != null && integer(p.flags, `${path}.flags`, true, 32) !== 0n)
        fail(
          'UNSUPPORTED_FLAGS',
          'Points flagged as missing observations or with unknown flags cannot be counted.',
          path,
          'UNSUPPORTED_INPUT',
        );
      if (p.asDouble != null)
        fail(
          'DOUBLE_COUNTER',
          'asDouble is not supported. A request counter must use asInt.',
          path,
          'UNSUPPORTED_INPUT',
        );
      if (p.asInt == null) fail('MISSING_COUNT', 'The point has no asInt count.', path);
      const n = integer(p.asInt, `${path}.asInt`);
      if (n < 0n) fail('NEGATIVE_COUNT', 'A request counter must be nonnegative.', path);
      let overflow = false;
      if (Object.hasOwn(attrs, OVERFLOW)) {
        if (attrs[OVERFLOW] !== true)
          fail('INVALID_OVERFLOW_MARKER', 'The overflow marker must be boolValue: true.', path);
        if (Object.keys(attrs).length !== 1)
          fail(
            'AMBIGUOUS_OVERFLOW',
            'The overflow marker has additional measurement attributes. This may be Cardinality Guardian tagging, not SDK attribution loss.',
            path,
            'UNSUPPORTED_INPUT',
          );
        overflow = true;
        O += n;
      } else {
        if (!Object.hasOwn(attrs, settings.outcomeAttribute))
          fail(
            'MISSING_OUTCOME',
            `Every ordinary point needs the ${settings.outcomeAttribute} measurement attribute.`,
            path,
          );
        if (typeof attrs[settings.outcomeAttribute] !== 'boolean')
          fail(
            'NON_BOOLEAN_OUTCOME',
            'The selected outcome must be a boolValue on every ordinary point.',
            path,
          );
        K += n;
        if (attrs[settings.outcomeAttribute] === settings.errorValue) E += n;
      }
      return { attributes: attrs, count: n.toString(), overflow };
    });
    return { ...calculate(K, E, O, threshold), points };
  } catch (error) {
    const d = diagnostic(error);
    return { status: d.status, diagnostic: d };
  }
}
export function outcomeCandidates(stream: Stream, intervalId: string): string[] {
  const keys = new Set<string>();
  for (const p of stream.intervals.find((i) => i.id === intervalId)?.points ?? []) {
    try {
      for (const key of Object.keys(attributes(p.attributes, 'attributes')))
        if (key !== OVERFLOW) keys.add(key);
    } catch {
      /* analyze reports the exact problem */
    }
  }
  return [...keys].sort();
}
