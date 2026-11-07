import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compare } from '../src/core/calculate';
import { analyzeHttpCumulative, pairHttpCumulative } from '../src/core/httpCumulative';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import { makeHttpCumulativeReport } from '../src/core/report';
import type { Stream } from '../src/core/types';

type Step = { status: number; count: number };
type Phase = {
  plan: Step[];
  total: number;
  serverErrors: number;
  observedStatuses: Step[];
};
type FileEvidence = {
  role: 'before' | 'after' | 'zero' | 'restart';
  file: string;
  sha256: string;
  bytes: number;
  timeUnixNano: string;
  startTimeUnixNano: string[];
  total: string;
  ordinaryPoints: number;
  overflowPoints: number;
  overflowCount: string;
};
const read = (name: string) => readFileSync(new URL(`../fixtures/http/${name}`, import.meta.url));
const manifest = JSON.parse(read('cumulative-manifest.json').toString('utf8')) as {
  modules: Record<string, string>;
  semconv: string;
  temporality: string;
  aggregation: string;
  views: string;
  commands: string[];
  cardinalityLimit: number;
  explicitBounds: number[];
  baseline: Phase;
  window: Phase;
  files: FileEvidence[];
  harnessSources: { file: string; sha256: string }[];
  result: Record<
    'K' | 'E' | 'O' | 'T' | 'truthTotal' | 'truthServerErrors' | 'baselineTotal' | 'afterTotal',
    string
  >;
};
const evidence = (role: FileEvidence['role']) => {
  const found = manifest.files.find((f) => f.role === role);
  if (!found) throw new Error(`missing ${role}`);
  return found;
};
function load(role: FileEvidence['role']) {
  const f = evidence(role);
  const data = normalize(parseOtlp(read(f.file).toString('utf8')));
  const stream = data.streams.find((s) => s.identity.name === 'http.server.request.duration');
  if (!stream) throw new Error('missing stream');
  return { data, stream };
}
const settings = (before: Stream, after: Stream, threshold = '1') => ({
  beforeSnapshotId: before.snapshots[0].id,
  afterSnapshotId: after.snapshots[0].id,
  threshold,
  contractConfirmed: true,
});

describe('real Go otelhttp cumulative exports', () => {
  const before = load('before'),
    after = load('after'),
    zero = load('zero'),
    restart = load('restart');

  test('the manifest pins versions, settings, commands, sources and files', () => {
    expect(manifest.modules['go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp']).toBe(
      'v0.72.0',
    );
    expect(manifest.modules['go.opentelemetry.io/otel/sdk/metric']).toBe('v1.47.0');
    expect(
      manifest.modules['go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp'],
    ).toBe('v1.47.0');
    expect(manifest.semconv).toContain('v1.43.0');
    expect(manifest.temporality).toContain('without a temporality selector');
    expect(manifest.views).toBe('none');
    expect(manifest.cardinalityLimit).toBe(8);
    expect(manifest.commands).toContain('npm run validate:http-cumulative');
    expect(manifest.explicitBounds).toHaveLength(14);
    expect(manifest.harnessSources.map((s) => s.file)).toEqual([
      'validation/http/main.go',
      'validation/http/cumulative.go',
      'validation/go.mod',
      'validation/go.sum',
    ]);
    for (const s of manifest.harnessSources) expect(s.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const f of manifest.files) {
      const bytes = read(f.file);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
      expect(bytes.length).toBe(f.bytes);
    }
  });

  test('the independent client tallies match both plans and the manifest', () => {
    for (const phase of [manifest.baseline, manifest.window]) {
      const planned = new Map<number, number>();
      for (const step of phase.plan as unknown as { status: number; count: number }[])
        planned.set(step.status, (planned.get(step.status) ?? 0) + step.count);
      expect(phase.observedStatuses).toEqual(
        [...planned].sort(([a], [b]) => a - b).map(([status, count]) => ({ status, count })),
      );
      expect(phase.observedStatuses.reduce((n, o) => n + o.count, 0)).toBe(phase.total);
      expect(
        phase.observedStatuses.filter((o) => o.status >= 500).reduce((n, o) => n + o.count, 0),
      ).toBe(phase.serverErrors);
    }
    expect(manifest.result.truthTotal).toBe(String(manifest.window.total));
    expect(manifest.result.truthServerErrors).toBe(String(manifest.window.serverErrors));
  });

  test('every file imports cleanly as three cumulative histograms with one timestamp', () => {
    for (const [role, loaded] of Object.entries({ before, after, zero, restart })) {
      const f = evidence(role as FileEvidence['role']);
      expect(loaded.data.diagnostics).toEqual([]);
      expect(loaded.data.streams.map((s) => s.identity.name).sort()).toEqual([
        'http.server.request.body.size',
        'http.server.request.duration',
        'http.server.response.body.size',
      ]);
      expect(loaded.data.streams.every((s) => !s.diagnostics.length)).toBe(true);
      expect(loaded.stream.identity).toMatchObject({
        type: 'histogram',
        temporality: 'CUMULATIVE',
        unit: 's',
      });
      expect(loaded.stream.snapshots).toHaveLength(1);
      expect(loaded.stream.snapshots[0].end).toBe(f.timeUnixNano);
      expect(loaded.stream.snapshots[0].points).toHaveLength(f.ordinaryPoints + f.overflowPoints);
      expect(loaded.stream.intervals).toEqual([]);
    }
  });

  test('both snapshots contain ordinary series and overflow within the small limit', () => {
    for (const f of [evidence('before'), evidence('after')]) {
      expect(f.ordinaryPoints).toBeGreaterThan(0);
      expect(f.overflowPoints).toBe(1);
      expect(Number(f.overflowCount)).toBeGreaterThan(0);
      expect(f.ordinaryPoints + f.overflowPoints).toBeLessThanOrEqual(manifest.cardinalityLimit);
      expect(f.startTimeUnixNano).toHaveLength(1);
    }
    expect(evidence('before').total).toBe(manifest.result.baselineTotal);
    expect(evidence('after').total).toBe(manifest.result.afterTotal);
    expect(BigInt(evidence('before').timeUnixNano)).toBeLessThan(
      BigInt(evidence('after').timeUnixNano),
    );
  });

  test('window counts are the increments and the true 5xx share lies inside the bounds', () => {
    const r = analyzeHttpCumulative(
      before.stream,
      after.stream,
      settings(before.stream, after.stream, '10'),
    );
    if (!('lower' in r) || !r.lower || !r.upper || !('evidence' in r))
      throw new Error(JSON.stringify(r));
    for (const key of ['K', 'E', 'O', 'T'] as const)
      expect(r[key].toString()).toBe(manifest.result[key]);
    // Baseline requests are not part of the window.
    expect(r.T).toBe(BigInt(manifest.window.total));
    expect(r.T).toBe(BigInt(manifest.result.afterTotal) - BigInt(manifest.result.baselineTotal));
    expect(r.evidence.window).toEqual({
      startTimeUnixNano: evidence('before').timeUnixNano,
      timeUnixNano: evidence('after').timeUnixNano,
    });
    const truth = {
      numerator: BigInt(manifest.window.serverErrors),
      denominator: BigInt(manifest.window.total),
    };
    expect(compare(truth, r.lower)).toBeGreaterThan(0n);
    expect(compare(truth, r.upper)).toBeLessThan(0n);
    expect(r.O).toBeGreaterThan(0n);
    expect(r.points.filter((p) => p.overflow)).toHaveLength(1);
    expect(r.status).toBe('INDETERMINATE');
    for (const p of r.points)
      expect(BigInt(p.afterCount) - BigInt(p.beforeCount)).toBe(BigInt(p.count));
  });

  test('reversing the files is refused and the report keeps both hashes', () => {
    expect(
      pairHttpCumulative(after.stream, before.stream, settings(after.stream, before.stream)),
    ).toMatchObject({ diagnostic: { code: 'INVALID_WINDOW' } });
    const s = settings(before.stream, after.stream);
    const report = JSON.parse(
      makeHttpCumulativeReport(
        before.stream,
        after.stream,
        s,
        analyzeHttpCumulative(before.stream, after.stream, s),
        {
          before: { name: 'b', sha256: evidence('before').sha256, bytes: evidence('before').bytes },
          after: { name: 'a', sha256: evidence('after').sha256, bytes: evidence('after').bytes },
        },
      ),
    );
    expect(report.sources.before.sha256).toBe(evidence('before').sha256);
    expect(report.sources.after.sha256).toBe(evidence('after').sha256);
    expect(report.result).toMatchObject({ K: manifest.result.K, T: manifest.result.T });
  });

  test('a later collection without new requests is no observations', () => {
    expect(
      analyzeHttpCumulative(after.stream, zero.stream, settings(after.stream, zero.stream)),
    ).toMatchObject({ status: 'NO_DATA', T: 0n, lower: null, upper: null });
  });

  test('a restarted SDK is refused even though every count is at least the first snapshot', () => {
    const counts = (s: Stream) =>
      new Map(
        s.snapshots[0].points.map((p) => [
          JSON.stringify(p.attributes),
          BigInt(String(p.count ?? '0')),
        ]),
      );
    const b = counts(before.stream),
      r = counts(restart.stream);
    expect(r.size).toBe(b.size);
    // A count-only comparison would accept this pair and report a window.
    expect([...b].every(([key, count]) => (r.get(key) ?? -1n) >= count)).toBe(true);
    expect(evidence('restart').startTimeUnixNano).not.toEqual(evidence('before').startTimeUnixNano);
    for (const [from, to] of [
      [before.stream, restart.stream],
      [after.stream, restart.stream],
    ]) {
      expect(pairHttpCumulative(from, to, settings(from, to))).toMatchObject({
        status: 'UNSUPPORTED_INPUT',
        diagnostic: { code: 'CHANGED_START_TIME' },
      });
    }
  });

  test('the other HTTP histograms in the files are not accepted as the metric', () => {
    for (const s of after.data.streams.filter((s) => s !== after.stream)) {
      const r = pairHttpCumulative(s, s, settings(s, s));
      expect(r).toMatchObject({ diagnostic: { code: 'UNSUPPORTED_METRIC' } });
    }
  });
});
