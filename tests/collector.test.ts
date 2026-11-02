import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { analyzeCumulative, type CumulativeSettings } from '../src/core/cumulative';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import type { Rational } from '../src/core/types';

// Evidence captured by `npm run validate:collector -- --out ../fixtures/collector` from a pinned
// OpenTelemetry Collector. These tests only read it; they never start Docker or download anything.
const dir = new URL('../fixtures/collector/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
type Observation = { success: boolean; requestId: string; count: number };
type Counts = { K: number; E: number; O: number; T: number };
const manifest = JSON.parse(read('manifest.json')) as {
  pinned: { image: string; version: string };
  groundTruth: {
    observations: Observation[];
    baselineObservations: Observation[];
    truthTotal: number;
    truthErrors: number;
    baselineTotal: number;
  };
  semantic: Record<
    string,
    {
      window: Counts;
      zeroWindow: Counts;
      sdkWindow: Counts;
      truthContained: boolean;
      reexportEqualsAfter: boolean;
      removedPoints?: { phase: string; attributes: string; value: number }[];
      lostWindowOverflow?: number;
      prometheus: Record<string, { contentType: string; family: string; total: number }>;
    }
  >;
  provenance: { artifactSha256: Record<string, string> };
};
const sdkManifest = JSON.parse(
  readFileSync(new URL('../fixtures/sdk/manifest.json', import.meta.url), 'utf8'),
) as {
  cases: { groundTruth: Observation[] }[];
  cumulativeCases: { baselineGroundTruth: Observation[] }[];
};

// Independent ground truth: the recorded workload, never the aggregated OTLP.
const truthTotal = BigInt(manifest.groundTruth.observations.reduce((n, o) => n + o.count, 0));
const truthErrors = BigInt(
  manifest.groundTruth.observations.reduce((n, o) => n + (o.success ? 0 : o.count), 0),
);
const truth: Rational = { numerator: truthErrors, denominator: truthTotal };

function stream(file: string) {
  const data = structuredClone(normalize(parseOtlp(read(file))));
  expect(data.diagnostics).toEqual([]);
  expect(data.streams).toHaveLength(1);
  expect(data.streams[0].diagnostics).toEqual([]);
  return data.streams[0];
}
function analyze(scenario: string, from: string, to: string, threshold: string) {
  const before = stream(`${scenario}-${from}.json`),
    after = stream(`${scenario}-${to}.json`);
  const settings: CumulativeSettings = {
    beforeSnapshotId: before.snapshots[0].id,
    afterSnapshotId: after.snapshots[0].id,
    outcomeAttribute: 'success',
    errorValue: false,
    threshold,
    contractConfirmed: true,
  };
  return analyzeCumulative(before, after, settings);
}
const fraction = (r: Rational | null) => (r ? `${r.numerator}/${r.denominator}` : null);

describe('Collector evidence integrity and ground truth', () => {
  test('the lab workload is the SDK harness workload', () => {
    expect(manifest.groundTruth.observations).toEqual(sdkManifest.cases[0].groundTruth);
    expect(manifest.groundTruth.baselineObservations).toEqual(
      sdkManifest.cumulativeCases[0].baselineGroundTruth,
    );
    expect(truthTotal).toBe(1000n);
    expect(truthErrors).toBe(34n);
    expect(manifest.groundTruth.baselineTotal).toBe(112);
  });

  test('every committed artifact matches its recorded SHA-256 and the pinned image is a digest', () => {
    const { artifactSha256 } = manifest.provenance;
    expect(Object.keys(artifactSha256).length).toBeGreaterThan(20);
    for (const [name, sha] of Object.entries(artifactSha256))
      expect(
        createHash('sha256')
          .update(readFileSync(new URL(name, dir)))
          .digest('hex'),
        name,
      ).toBe(sha);
    expect(manifest.pinned.image).toMatch(
      /^otel\/opentelemetry-collector-contrib@sha256:[0-9a-f]{64}$/,
    );
    expect(manifest.pinned.version).toBe('0.163.2');
  });
});

describe('positive pipeline: SDK → OTLP exporter → Collector → OTLP receiver', () => {
  test('stream identity and cumulative temporality survive the Collector', () => {
    const before = stream('positive-before.json'),
      after = stream('positive-after.json');
    expect(before.identity).toMatchObject({
      type: 'sum',
      monotonic: true,
      temporality: 'CUMULATIVE',
      name: 'http.server.requests',
      unit: '{request}',
    });
    expect(after.identity).toEqual(before.identity);
    expect(before.snapshots).toHaveLength(1);
    expect(after.snapshots).toHaveLength(1);
    expect(BigInt(after.snapshots[0].end)).toBeGreaterThan(BigInt(before.snapshots[0].end));
  });

  test('window excludes the nonzero baseline, conserves counts and contains the true 3.4%', () => {
    const result = analyze('positive', 'before', 'after', '1');
    if (!('K' in result) || !result.lower || !result.upper) throw new Error('window rejected');
    expect(result).toMatchObject({ K: 901n, E: 1n, O: 99n, T: 1000n, status: 'INDETERMINATE' });
    expect(result.T).toBe(truthTotal);
    expect(compare(truth, result.lower)).toBeGreaterThanOrEqual(0n);
    expect(compare(truth, result.upper)).toBeLessThanOrEqual(0n);
    expect(fraction(result.lower)).toBe('1/1000');
    expect(fraction(result.upper)).toBe('100/1000');
    const before = result.points.reduce((n, p) => n + BigInt(p.beforeCount), 0n),
      after = result.points.reduce((n, p) => n + BigInt(p.afterCount), 0n);
    expect(before).toBe(BigInt(manifest.groundTruth.baselineTotal));
    expect(after).toBe(before + truthTotal);
    expect(result.T).not.toBe(after);
    const overflow = result.points.find((p) => p.overflow);
    expect(BigInt(overflow?.beforeCount ?? 0)).toBeGreaterThan(0n);
    expect(manifest.semantic.positive.window).toEqual({ K: 901, E: 1, O: 99, T: 1000 });
    expect(manifest.semantic.positive.truthContained).toBe(true);
  });

  test.each([
    ['0', 'EXCEEDS_LIMIT'],
    ['1', 'INDETERMINATE'],
    ['10', 'WITHIN_LIMIT'],
  ])('threshold %s%% gives %s', (threshold, status) => {
    expect(analyze('positive', 'before', 'after', threshold)).toMatchObject({ status });
  });

  test('a collection without new observations is NO_DATA and no export is summed twice', () => {
    expect(analyze('positive', 'after', 'zero', '1')).toMatchObject({
      status: 'NO_DATA',
      T: 0n,
      lower: null,
      upper: null,
    });
    // Window arithmetic uses one pair: the extra zero collection does not change it.
    expect(analyze('positive', 'before', 'after', '1')).toMatchObject({ T: 1000n });
    expect(manifest.semantic.positive.zeroWindow).toEqual({ K: 0, E: 0, O: 0, T: 0 });
    // An exact re-delivery of the After snapshot was received and was identical, not additive.
    expect(manifest.semantic.positive.reexportEqualsAfter).toBe(true);
  });
});

// Test-local line filter for the one selected counter family; not a Prometheus parser.
function samples(file: string, name: string) {
  return read(file)
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`))
    .map((line) => {
      const match = /^\S+\{(.*)\} (\S+)$/.exec(line);
      if (!match) throw new Error(line);
      return { labels: match[1], value: Number(match[2]) };
    });
}

describe('Prometheus exposition of the same pipeline (evidence channel, not product input)', () => {
  const after = analyze('positive', 'before', 'after', '1');
  if (!('points' in after)) throw new Error('window rejected');
  const otlpAfterTotal = after.points.reduce((n, p) => n + Number(p.afterCount), 0);
  const otlpOverflow = after.points
    .filter((p) => p.overflow)
    .reduce((n, p) => n + Number(p.afterCount), 0);

  test.each([
    ['positive', 'http_server_requests_total', 'text/plain; version=0.0.4'],
    ['positive-openmetrics', 'http_server_requests_total', 'application/openmetrics-text'],
  ])('%s: family counts equal the OTLP After snapshot and the workload', (scenario, name, type) => {
    const prom = manifest.semantic[scenario].prometheus;
    expect(prom.after.contentType.startsWith(type)).toBe(true);
    const rows = samples(`${scenario}-prometheus-after.prom`, name);
    expect(rows.reduce((n, r) => n + r.value, 0)).toBe(otlpAfterTotal);
    expect(otlpAfterTotal).toBe(manifest.groundTruth.baselineTotal + Number(truthTotal));
    const overflow = rows.filter((r) => r.labels.includes('otel_metric_overflow="true"'));
    expect(overflow).toHaveLength(1);
    expect(overflow[0].value).toBe(otlpOverflow);
    expect(prom.after.total).toBe(otlpAfterTotal);
    // Service samples are present but are not request counts.
    expect(read(`${scenario}-prometheus-after.prom`)).toContain('target_info{');
  });

  test('negotiation: the default exporter answers an OpenMetrics Accept with classic text', () => {
    const probe = manifest.semantic.positive.prometheus.negotiationProbe as unknown as {
      contentType: string;
    };
    expect(probe.contentType).toContain('text/plain; version=0.0.4');
    const om = manifest.semantic['positive-openmetrics'].prometheus;
    expect(om.after.contentType).toContain('application/openmetrics-text; version=1.0.0');
    expect(om.after.family).toBe('http_server_requests');
  });

  test('repeated scrapes and a re-delivered export do not add counts', () => {
    const lines = (file: string) => read(file).split('\n').sort();
    const body = lines('positive-prometheus-after.prom');
    expect(lines('positive-prometheus-after-repeat.prom')).toEqual(body);
    expect(lines('positive-prometheus-after-reexport.prom')).toEqual(body);
    expect(lines('positive-prometheus-zero.prom')).toEqual(body);
    const prom = manifest.semantic.positive.prometheus;
    for (const phase of ['after', 'zero', 'afterReexport'])
      expect(prom[phase].total, phase).toBe(otlpAfterTotal);
  });
});

describe('negative control: overflow removed downstream (known only because of the lab)', () => {
  test('the Collector removed exactly the overflow points and nothing else', () => {
    const removed = manifest.semantic['drop-overflow'].removedPoints ?? [];
    expect(removed.map((p) => [p.phase, p.attributes])).toEqual([
      ['before', 'otel.metric.overflow=b:true'],
      ['after', 'otel.metric.overflow=b:true'],
      ['zero', 'otel.metric.overflow=b:true'],
    ]);
    expect(removed.map((p) => p.value)).toEqual([5, 104, 104]);
    expect(manifest.semantic['drop-overflow'].lostWindowOverflow).toBe(99);
    expect(read('drop-overflow-after.json')).not.toContain('otel.metric.overflow');
    const kept = (file: string) =>
      Object.fromEntries(
        stream(file).snapshots[0].points.map((p) => [JSON.stringify(p.attributes), p.asInt]),
      );
    const positive = kept('positive-after.json');
    const dropped = kept('drop-overflow-after.json');
    const expected = Object.fromEntries(
      Object.entries(positive).filter(([key]) => !key.includes('otel.metric.overflow')),
    );
    expect(dropped).toEqual(expected);
  });

  test('the filtered files are formally valid and give an exact rate for the received counts', () => {
    const result = analyze('drop-overflow', 'before', 'after', '1');
    if (!('K' in result) || !result.lower || !result.upper) throw new Error('window rejected');
    // No diagnostic and no applicability warning: the loss leaves no trace in the data.
    expect(result).toMatchObject({ K: 901n, E: 1n, O: 0n, T: 901n, status: 'WITHIN_LIMIT' });
    expect(fraction(result.lower)).toBe('1/901');
    expect(fraction(result.upper)).toBe('1/901');
    expect(result.evidence.checks.length).toBeGreaterThan(0);
  });

  test('the same file cannot bound the original workload: provenance was violated', () => {
    const result = analyze('drop-overflow', 'before', 'after', '1');
    if (!('K' in result) || !result.lower || !result.upper) throw new Error('window rejected');
    // Arithmetic is correct for 901 received requests, but the original total was 1,000 and its
    // rate 3.4%, outside the computed 1/901 bounds. Only the controlled lab knows this.
    expect(result.T).toBeLessThan(truthTotal);
    expect(compare(truth, result.upper)).toBeGreaterThan(0n);
    expect(manifest.semantic['drop-overflow'].truthContained).toBe(false);
    // At 1% the received counts say WITHIN_LIMIT while the true 3.4% exceeds it.
    expect(truth.numerator * 100n).toBeGreaterThan(truth.denominator);
    for (const [threshold, status] of [
      ['0', 'EXCEEDS_LIMIT'],
      ['1', 'WITHIN_LIMIT'],
      ['10', 'WITHIN_LIMIT'],
    ])
      expect(analyze('drop-overflow', 'before', 'after', threshold)).toMatchObject({ status });
    expect(analyze('drop-overflow', 'after', 'zero', '1')).toMatchObject({ status: 'NO_DATA' });
  });
});

// Results of the product on the captured artifacts. Regenerate with
// OVERFLOWLENS_WRITE_ANALYSIS=1 npx vitest run tests/collector.test.ts after a new capture.
test('analysis.json records the product results for the captured artifacts', () => {
  const cases = [
    ['positive', 'before', 'after', '0'],
    ['positive', 'before', 'after', '1'],
    ['positive', 'before', 'after', '10'],
    ['positive', 'after', 'zero', '1'],
    ['drop-overflow', 'before', 'after', '0'],
    ['drop-overflow', 'before', 'after', '1'],
    ['drop-overflow', 'before', 'after', '10'],
    ['drop-overflow', 'after', 'zero', '1'],
  ].map(([scenario, from, to, threshold]) => {
    const result = analyze(scenario, from, to, threshold);
    const counts =
      'K' in result
        ? {
            K: String(result.K),
            E: String(result.E),
            O: String(result.O),
            T: String(result.T),
            lower: fraction(result.lower),
            upper: fraction(result.upper),
          }
        : { diagnostic: result.diagnostic.code };
    return {
      scenario,
      before: `${scenario}-${from}.json`,
      after: `${scenario}-${to}.json`,
      thresholdPercent: threshold,
      status: result.status,
      ...counts,
      trueRate: `${truthErrors}/${truthTotal}`,
      trueRateWithinBounds:
        'K' in result && result.lower && result.upper
          ? compare(truth, result.lower) >= 0n && compare(truth, result.upper) <= 0n
          : null,
    };
  });
  const recorded = `${JSON.stringify({ schema: 1, cases }, null, 2)}\n`;
  if (process.env.OVERFLOWLENS_WRITE_ANALYSIS)
    writeFileSync(new URL('analysis.json', dir), recorded);
  expect(read('analysis.json')).toBe(recorded);
});
