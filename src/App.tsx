import { useEffect, useMemo, useRef, useState } from 'react';
import demo from '../public/examples/demo.json?raw';
import { analyze, outcomeCandidates, type Settings } from './core/analyze';
import { formatPercent, scalePercent } from './core/calculate';
import { type CumulativeSettings, calculateCumulative, pairCumulative } from './core/cumulative';
import { attributes } from './core/parse';
import { makeCumulativeReport, makeReport, type Source } from './core/report';
import {
  type Analysis,
  CONTRACT,
  CUMULATIVE_CONTRACT,
  type Diagnostic,
  diagnostic,
  type ImportData,
  InputError,
  MAX_FILE_BYTES,
  MAX_PAIR_BYTES,
  OVERFLOW,
  type Rational,
} from './core/types';

const labels = {
  WITHIN_LIMIT: 'Within limit for the imported interval',
  EXCEEDS_LIMIT: 'Exceeds limit for the imported interval',
  INDETERMINATE: 'Cannot determine from these data',
  NO_DATA: 'No observations',
  UNSUPPORTED_INPUT: 'Unsupported input',
  INVALID_INPUT: 'Invalid input',
};
const defaults: Settings = {
  intervalId: '',
  outcomeAttribute: '',
  errorValue: false,
  threshold: '1',
  contractConfirmed: false,
};
type Side = 'before' | 'after';
function fraction(r: Rational) {
  return `${r.numerator} / ${r.denominator}`;
}
function time(n: string) {
  const d = new Date(Number(BigInt(n) / 1_000_000n));
  return Number.isNaN(d.getTime()) ? `${n} ns` : d.toISOString();
}
function Range({
  lower,
  upper,
  threshold,
  uncertain,
}: {
  lower: Rational;
  upper: Rational;
  threshold: Rational;
  uncertain: boolean;
}) {
  return (
    <figure
      className="range-visual"
      aria-label={`Possible error rate ${formatPercent(lower)} to ${formatPercent(upper)}; threshold ${formatPercent(threshold)}`}
    >
      <figcaption className="range-legend">
        <span>Possible error rate</span>
        <span>│ Maximum allowed: {formatPercent(threshold)}</span>
      </figcaption>
      <div className="track">
        <div
          className="band"
          style={{
            left: `${scalePercent(lower)}%`,
            width: `${scalePercent(upper) - scalePercent(lower)}%`,
            minWidth: uncertain ? '3px' : '0',
          }}
        />
        <i className="endpoint" style={{ left: `${scalePercent(lower)}%` }} />
        <i className="endpoint" style={{ left: `${scalePercent(upper)}%` }} />
        <i className="threshold" style={{ left: `${scalePercent(threshold)}%` }} />
      </div>
      <div className="axis">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>
      {uncertain && (
        <p className="chart-note">
          The interval has nonzero width. Very narrow ranges use a minimum visible mark; exact
          fractions are shown below.
        </p>
      )}
    </figure>
  );
}
export function App() {
  const [mode, setMode] = useState<'delta' | 'cumulative'>('delta');
  const [afterData, setAfterData] = useState<ImportData | null>(null);
  const [afterSource, setAfterSource] = useState<Source | null>(null);
  const [afterError, setAfterError] = useState<Diagnostic | null>(null);
  const [afterStreamId, setAfterStreamId] = useState('');
  const [beforeSnapshotId, setBeforeSnapshotId] = useState('');
  const [afterSnapshotId, setAfterSnapshotId] = useState('');
  const [afterBusy, setAfterBusy] = useState(false);
  const [data, setData] = useState<ImportData | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [importError, setImportError] = useState<Diagnostic | null>(null);
  const [streamId, setStreamId] = useState('');
  const [settings, setSettings] = useState<Settings>(defaults);
  const [busy, setBusy] = useState(false);
  const revision = useRef({ before: 0, after: 0 });
  const importer = useRef<Partial<Record<Side, { worker: Worker; cancel: () => void }>>>({});
  const loaded = useRef<Partial<Record<Side, ImportData>>>({});
  useEffect(
    () => () => {
      for (const pending of Object.values(importer.current)) {
        pending.worker.terminate();
        pending.cancel();
      }
    },
    [],
  );
  const stream = data?.streams.find((s) => s.id === streamId);
  const afterStream = afterData?.streams.find((s) => s.id === afterStreamId);
  const cumulativeSettings: CumulativeSettings = useMemo(
    () => ({
      beforeSnapshotId,
      afterSnapshotId,
      outcomeAttribute: settings.outcomeAttribute,
      errorValue: settings.errorValue,
      threshold: settings.threshold,
      contractConfirmed: settings.contractConfirmed,
    }),
    [settings, beforeSnapshotId, afterSnapshotId],
  );
  const candidates = useMemo(() => {
    if (!stream) return [];
    if (mode === 'delta') return outcomeCandidates(stream, settings.intervalId);
    const keys = new Set<string>();
    for (const p of stream.snapshots.find((s) => s.id === beforeSnapshotId)?.points ?? []) {
      try {
        for (const key of Object.keys(attributes(p.attributes, 'attributes')))
          if (key !== OVERFLOW) keys.add(key);
      } catch {
        /* applicability reports the malformed attributes */
      }
    }
    return [...keys].sort();
  }, [stream, settings.intervalId, mode, beforeSnapshotId]);
  const selection = useMemo(
    () => ({
      beforeSnapshotId,
      afterSnapshotId,
      outcomeAttribute: settings.outcomeAttribute,
      errorValue: settings.errorValue,
    }),
    [beforeSnapshotId, afterSnapshotId, settings.outcomeAttribute, settings.errorValue],
  );
  const pairing = useMemo(
    () =>
      mode === 'cumulative' && stream && afterStream
        ? pairCumulative(stream, afterStream, selection)
        : null,
    [mode, stream, afterStream, selection],
  );
  const result: Analysis | null = useMemo(() => {
    if (!stream || busy || afterBusy) return null;
    if (mode === 'delta') return analyze(stream, settings);
    return pairing ? calculateCumulative(pairing, cumulativeSettings) : null;
  }, [stream, pairing, settings, cumulativeSettings, mode, busy, afterBusy]);
  const valid = result && 'K' in result ? result : null;
  function reset(side?: Side) {
    for (const key of side ? [side] : (['before', 'after'] as const)) {
      importer.current[key]?.worker.terminate();
      importer.current[key]?.cancel();
      delete importer.current[key];
      delete loaded.current[key];
      if (key === 'before') {
        setData(null);
        setSource(null);
        setImportError(null);
      } else {
        setAfterData(null);
        setAfterSource(null);
        setAfterError(null);
      }
    }
    setStreamId('');
    setAfterStreamId('');
    setBeforeSnapshotId('');
    setAfterSnapshotId('');
    setSettings({ ...defaults });
  }
  async function load(
    text: string,
    name: string,
    token: number,
    side: Side = 'before',
    originalBytes?: Uint8Array<ArrayBuffer>,
  ) {
    if (revision.current[side] !== token) return;
    try {
      const bytes = originalBytes ?? new TextEncoder().encode(text);
      const parsing = new Promise<ImportData>((resolve, reject) => {
        const worker = new Worker(new URL('./import.worker.ts', import.meta.url), {
          type: 'module',
        });
        importer.current[side] = { worker, cancel: () => reject(new Error('Import replaced')) };
        worker.onmessage = (event: MessageEvent<{ data?: ImportData; error?: Diagnostic }>) => {
          worker.terminate();
          if (importer.current[side]?.worker === worker) delete importer.current[side];
          if (event.data.error) reject(new InputError(event.data.error));
          else if (event.data.data) resolve(event.data.data);
        };
        worker.onerror = () => {
          worker.terminate();
          if (importer.current[side]?.worker === worker) delete importer.current[side];
          reject(
            new InputError({
              status: 'INVALID_INPUT',
              code: 'IMPORT_FAILED',
              message:
                'The local parsing worker failed. Check the file and reload the application.',
            }),
          );
        };
        worker.postMessage(text);
      });
      const [parsed, hash] = await Promise.all([parsing, crypto.subtle.digest('SHA-256', bytes)]);
      if (revision.current[side] !== token) return;
      loaded.current[side] = parsed;
      (side === 'before' ? setData : setAfterData)(parsed);
      (side === 'before' ? setSource : setAfterSource)({
        name,
        bytes: bytes.length,
        sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
      });
      const first =
        parsed.streams.find(
          (s) =>
            !s.diagnostics.length &&
            s.identity.temporality === (mode === 'delta' ? 'DELTA' : 'CUMULATIVE'),
        ) ?? parsed.streams[0];
      if (first) {
        (side === 'before' ? setStreamId : setAfterStreamId)(first.id);
        (side === 'before' ? setBeforeSnapshotId : setAfterSnapshotId)(
          first.snapshots[0]?.id ?? '',
        );
        const other = loaded.current[side === 'before' ? 'after' : 'before'];
        const match = other?.streams.find((s) => s.id === first.id) ?? other?.streams[0];
        if (match) {
          (side === 'before' ? setAfterStreamId : setStreamId)(match.id);
          (side === 'before' ? setAfterSnapshotId : setBeforeSnapshotId)(
            match.snapshots[0]?.id ?? '',
          );
        }
        setSettings({ ...defaults, intervalId: first.intervals[0]?.id ?? '' });
      } else
        (side === 'before' ? setImportError : setAfterError)(
          parsed.diagnostics[0] ?? {
            status: 'INVALID_INPUT',
            code: 'NO_METRICS',
            message: 'The export contains no selectable metric definitions.',
          },
        );
    } catch (error) {
      if (revision.current[side] === token)
        (side === 'before' ? setImportError : setAfterError)(diagnostic(error));
    } finally {
      if (revision.current[side] === token) (side === 'before' ? setBusy : setAfterBusy)(false);
    }
  }
  async function importFile(file?: File, side: Side = 'before') {
    const token = ++revision.current[side];
    reset(side);
    if (!file) {
      (side === 'before' ? setBusy : setAfterBusy)(false);
      return;
    }
    const otherBytes = (side === 'before' ? afterSource : source)?.bytes ?? 0;
    if (file.size > MAX_FILE_BYTES || file.size + otherBytes > MAX_PAIR_BYTES) {
      (side === 'before' ? setBusy : setAfterBusy)(false);
      (side === 'before' ? setImportError : setAfterError)({
        status: 'INVALID_INPUT',
        code: 'FILE_TOO_LARGE',
        message:
          'Files are limited to 5 MiB each and 10 MiB per pair. Export smaller complete snapshots.',
      });
      return;
    }
    (side === 'before' ? setBusy : setAfterBusy)(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await load(text, file.name, token, side, bytes);
    } catch {
      if (revision.current[side] === token) {
        (side === 'before' ? setImportError : setAfterError)({
          status: 'INVALID_INPUT',
          code: 'FILE_READ_FAILED',
          message: 'The local file could not be read as UTF-8.',
        });
        (side === 'before' ? setBusy : setAfterBusy)(false);
      }
    }
  }
  function exportReport() {
    if (!stream || !result || !source) return;
    if (mode === 'cumulative' && (!afterStream || !afterSource)) return;
    const report =
      mode === 'cumulative' && afterStream && afterSource
        ? makeCumulativeReport(stream, afterStream, cumulativeSettings, result, {
            before: source,
            after: afterSource,
          })
        : makeReport(stream, settings, result, source);
    const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'overflowlens-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <header className="site-header">
        <a className="brand" href="./">
          <img src="./icon.svg" alt="" />
          <strong>OverflowLens</strong>
          <span className="version">v0.2</span>
        </a>
        <span className="local-badge">
          <i /> Local analysis · No uploads
        </span>
      </header>
      <main>
        <section className="intro">
          <div className="eyebrow">OPENTELEMETRY / CARDINALITY OVERFLOW</div>
          <h1>
            Lost attributes.
            <br />
            <span>Honest conclusions.</span>
          </h1>
          <p>
            When your SDK keeps the count but loses the outcome, how much can your error rate still
            tell you? Find the exact range the data supports.
          </p>
          <div className="intro-tags">
            <span>Exact arithmetic</span>
            <span>One interval or cumulative window</span>
            <span>Explainable results</span>
          </div>
        </section>
        <div className="workspace">
          <div className="controls">
            <section className="panel">
              <div className="step-heading">
                <span className="step">01</span>
                <h2>Bring your metrics</h2>
              </div>
              <label>
                Analysis mode
                <select
                  value={mode}
                  onChange={(e) => {
                    revision.current.before++;
                    revision.current.after++;
                    reset();
                    setBusy(false);
                    setAfterBusy(false);
                    setMode(e.target.value as 'delta' | 'cumulative');
                  }}
                >
                  <option value="delta">Delta interval</option>
                  <option value="cumulative">Cumulative window</option>
                </select>
              </label>
              {mode === 'cumulative' && (
                <p className="fine">
                  Two full exports · 5 MiB per file · 10 MiB per pair. Before is the baseline; after
                  ends the window.
                </p>
              )}
              <label className="file-area" htmlFor="file">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5" />
                </svg>
                <strong>
                  {mode === 'cumulative' ? 'Before: ' : ''}
                  {busy ? 'Reading local file…' : (source?.name ?? 'Choose an OTLP JSON file')}
                </strong>
                <span>ExportMetricsServiceRequest · Up to 5 MiB</span>
                <input
                  id="file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    void importFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {mode === 'cumulative' && (
                <label className="file-area" htmlFor="after-file">
                  <strong>
                    After:{' '}
                    {afterBusy
                      ? 'Reading local file…'
                      : (afterSource?.name ?? 'Choose an OTLP JSON file')}
                  </strong>
                  <span>ExportMetricsServiceRequest · Up to 5 MiB</span>
                  <input
                    id="after-file"
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => {
                      void importFile(e.target.files?.[0], 'after');
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
              {afterError && (
                <div className="diagnostic" role="alert">
                  <strong>After: {labels[afterError.status]}</strong>
                  <p>{afterError.message}</p>
                  <code>{afterError.code}</code>
                </div>
              )}
              {afterData && afterData.diagnostics.length > 0 && (
                <details>
                  <summary>After import diagnostics</summary>
                  {afterData.diagnostics.map((d) => (
                    <p key={JSON.stringify(d)}>
                      <code>{d.code}</code> {d.message}
                    </p>
                  ))}
                </details>
              )}
              <button
                type="button"
                className="demo-button"
                disabled={busy || afterBusy || mode === 'cumulative'}
                onClick={() => {
                  const token = ++revision.current.before;
                  reset();
                  setBusy(true);
                  void load(demo, 'demo.json · mathematical example', token);
                }}
              >
                Load the 900 / 1 / 99 example <span>↗</span>
              </button>
              {importError && (
                <div className="diagnostic" role="alert">
                  <strong>{labels[importError.status]}</strong>
                  <p>{importError.message}</p>
                  <code>{importError.code}</code>
                </div>
              )}
              {data && data.diagnostics.length > 0 && (
                <details>
                  <summary>{data.diagnostics.length} import diagnostic(s)</summary>
                  {data.diagnostics.map((d) => (
                    <p key={JSON.stringify(d)}>
                      <code>{d.code}</code> {d.message} {d.path}
                    </p>
                  ))}
                </details>
              )}
            </section>
            <section className="panel">
              <div className="step-heading">
                <span className="step">02</span>
                <h2>Select the interval</h2>
              </div>
              <label>
                {mode === 'cumulative' ? 'Before metric stream' : 'Metric stream'}
                <select
                  disabled={!data || busy || afterBusy}
                  value={streamId}
                  onChange={(e) => {
                    const s = data?.streams.find((s) => s.id === e.target.value);
                    setStreamId(e.target.value);
                    setBeforeSnapshotId(s?.snapshots[0]?.id ?? '');
                    setAfterStreamId('');
                    setAfterSnapshotId('');
                    setSettings({ ...defaults, intervalId: s?.intervals[0]?.id ?? '' });
                  }}
                >
                  <option value="">Select a metric</option>
                  {data?.streams.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {i + 1}. {s.identity.name} · {s.identity.scope.name || '(unnamed scope)'} ·{' '}
                      {s.identity.type} · {s.identity.temporality}
                      {s.diagnostics.length ||
                      s.identity.temporality !== (mode === 'delta' ? 'DELTA' : 'CUMULATIVE')
                        ? ' · unavailable'
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              {stream && (
                <details className="identity" open>
                  <summary>Stream identity</summary>
                  <dl>
                    <dt>Resource</dt>
                    <dd>
                      <code>{JSON.stringify(stream.identity.resource)}</code>
                    </dd>
                    <dt>Scope</dt>
                    <dd>
                      {stream.identity.scope.name || '(unnamed)'} {stream.identity.scope.version}
                      <code>{JSON.stringify(stream.identity.scope.attributes)}</code>
                    </dd>
                    <dt>Definition</dt>
                    <dd>
                      {stream.identity.type} · {stream.identity.unit || '(no unit)'} ·{' '}
                      {stream.identity.temporality} ·{' '}
                      {stream.identity.monotonic ? 'monotonic' : 'non-monotonic'}
                    </dd>
                    <dt>Schema URLs</dt>
                    <dd>
                      {stream.identity.resourceSchemaUrl || '(none)'} /{' '}
                      {stream.identity.scopeSchemaUrl || '(none)'}
                    </dd>
                  </dl>
                </details>
              )}
              {mode === 'delta' ? (
                <>
                  <label>
                    Collection interval
                    <select
                      disabled={!stream?.intervals.length}
                      value={settings.intervalId}
                      onChange={(e) => setSettings({ ...defaults, intervalId: e.target.value })}
                    >
                      <option value="">Select an interval</option>
                      {stream?.intervals.map((i) => (
                        <option key={i.id} value={i.id}>
                          {time(i.start)} → {time(i.end)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {settings.intervalId && (
                    <p className="fine">
                      Exact boundaries (Unix nanoseconds):{' '}
                      <code>{settings.intervalId.replace(':', ' → ')}</code>
                    </p>
                  )}
                </>
              ) : (
                <>
                  <label>
                    After metric stream
                    <select
                      disabled={!afterData || busy || afterBusy}
                      value={afterStreamId}
                      onChange={(e) => {
                        const selected = afterData?.streams.find((s) => s.id === e.target.value);
                        setAfterStreamId(e.target.value);
                        setAfterSnapshotId(selected?.snapshots[0]?.id ?? '');
                        setSettings({ ...defaults });
                      }}
                    >
                      <option value="">Select a metric</option>
                      {afterData?.streams.map((s, i) => (
                        <option key={s.id} value={s.id}>
                          {i + 1}. {s.identity.name} · {s.identity.scope.name} ·{' '}
                          {s.identity.temporality}
                          {s.id === stream?.id ? ' · matching identity' : ' · different identity'}
                          {s.diagnostics.length || s.identity.temporality !== 'CUMULATIVE'
                            ? ' · unavailable'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Before collection timestamp
                    <select
                      value={beforeSnapshotId}
                      disabled={!stream?.snapshots.length || busy || afterBusy}
                      onChange={(e) => {
                        setBeforeSnapshotId(e.target.value);
                        setAfterSnapshotId('');
                        setSettings({ ...defaults });
                      }}
                    >
                      <option value="">Select a boundary</option>
                      {stream?.snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {time(s.end)} · {s.end} ns
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    After collection timestamp
                    <select
                      value={afterSnapshotId}
                      disabled={!afterStream?.snapshots.length || busy || afterBusy}
                      onChange={(e) => {
                        setAfterSnapshotId(e.target.value);
                        setSettings({ ...defaults });
                      }}
                    >
                      <option value="">Select a boundary</option>
                      {afterStream?.snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {time(s.end)} · {s.end} ns
                        </option>
                      ))}
                    </select>
                  </label>
                  {beforeSnapshotId && afterSnapshotId && (
                    <p className="fine">
                      Window (Unix nanoseconds):{' '}
                      <code>
                        ({beforeSnapshotId}, {afterSnapshotId}]
                      </code>
                    </p>
                  )}
                  <div aria-live="polite" data-testid="applicability" className="fine">
                    {pairing?.status === 'APPLICABLE'
                      ? settings.contractConfirmed
                        ? 'Pair structurally applicable. Provenance confirmed by you.'
                        : 'Pair structurally applicable. Provenance still requires your confirmation.'
                      : pairing
                        ? `${pairing.diagnostic.code}: ${pairing.diagnostic.message}`
                        : 'Import and select both snapshots to check pair applicability.'}
                  </div>
                </>
              )}
            </section>
            <section className="panel">
              <div className="step-heading">
                <span className="step">03</span>
                <h2>State your assumptions</h2>
              </div>
              <label className="contract">
                <input
                  type="checkbox"
                  disabled={!stream || busy || afterBusy || (mode === 'cumulative' && !afterStream)}
                  checked={settings.contractConfirmed}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, contractConfirmed: e.target.checked }))
                  }
                />
                <span>{mode === 'cumulative' ? CUMULATIVE_CONTRACT : CONTRACT}</span>
              </label>
              <p className="fine">
                Choose the outcome before confirming. This is your assumption. A JSON file cannot
                prove completeness, SDK origin or synchronous instrumentation.
              </p>
              <label>
                Boolean outcome attribute
                <input
                  list="outcomes"
                  placeholder="e.g. success"
                  disabled={!stream || busy || afterBusy || (mode === 'cumulative' && !afterStream)}
                  value={settings.outcomeAttribute}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      outcomeAttribute: e.target.value,
                      errorValue: false,
                      threshold: '1',
                      contractConfirmed: false,
                    }))
                  }
                />
                <datalist id="outcomes">
                  {candidates.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </label>
              <div className="field-row">
                <label>
                  Error value
                  <select
                    disabled={
                      !stream || busy || afterBusy || (mode === 'cumulative' && !afterStream)
                    }
                    value={String(settings.errorValue)}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        errorValue: e.target.value === 'true',
                        contractConfirmed: false,
                      }))
                    }
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </label>
                <label>
                  Maximum error rate (%)
                  <input
                    inputMode="decimal"
                    disabled={
                      !stream || busy || afterBusy || (mode === 'cumulative' && !afterStream)
                    }
                    value={settings.threshold}
                    onChange={(e) => setSettings((s) => ({ ...s, threshold: e.target.value }))}
                  />
                </label>
              </div>
              <p className="fine">Equality is within the limit. Use a dot for decimals.</p>
            </section>
          </div>
          <div className="results">
            <section
              className={`panel result-panel ${result?.status.toLowerCase() ?? ''}`}
              aria-live="polite"
            >
              <div className="result-heading">
                <span className="eyebrow">WHAT THE DATA SUPPORTS</span>
                <span className="mini-label">
                  {mode === 'delta' ? 'INTERVAL ANALYSIS' : 'CUMULATIVE WINDOW'}
                </span>
              </div>
              {!result ? (
                <div className="empty">
                  <div className="empty-symbol">[ ? ]</div>
                  <h2>Your count tells part of the story.</h2>
                  <p>
                    Import an export or load the example, then select the outcome and confirm its
                    provenance to see the rest.
                  </p>
                </div>
              ) : valid ? (
                <>
                  <div className="verdict">
                    <span className="verdict-symbol">
                      {valid.status === 'WITHIN_LIMIT'
                        ? '✓'
                        : valid.status === 'EXCEEDS_LIMIT'
                          ? '!'
                          : '?'}
                    </span>
                    <h2>
                      {mode === 'cumulative'
                        ? labels[valid.status].replace('imported interval', 'cumulative window')
                        : labels[valid.status]}
                    </h2>
                  </div>
                  {valid.lower && valid.upper ? (
                    <>
                      <div className="range-number" data-testid="range">
                        {formatPercent(valid.lower)} <span>…</span> {formatPercent(valid.upper)}
                      </div>
                      <p className="range-caption">
                        {valid.O > 0n
                          ? 'Possible true error rate · nonzero uncertainty'
                          : 'Exact error rate · no overflow observations'}
                      </p>
                      <Range
                        lower={valid.lower}
                        upper={valid.upper}
                        threshold={valid.threshold}
                        uncertain={valid.O > 0n}
                      />
                      <div className="explanation">
                        <strong>
                          {valid.status === 'INDETERMINATE'
                            ? 'Both outcomes remain possible.'
                            : valid.status === 'WITHIN_LIMIT'
                              ? 'Every possible allocation meets your limit.'
                              : 'Every possible allocation exceeds your limit.'}
                        </strong>
                        <p>
                          {valid.status === 'INDETERMINATE'
                            ? 'Some allocations of the overflow count meet the threshold, and others exceed it. These data cannot settle the question.'
                            : valid.status === 'WITHIN_LIMIT'
                              ? 'Even if every overflow request was an error, the error rate would remain at or below the maximum.'
                              : 'Known errors alone exceed the maximum, even if every overflow request was successful.'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <p className="no-data">
                      The total count is zero. An error rate is undefined; no threshold conclusion
                      is possible.
                    </p>
                  )}
                </>
              ) : (
                <div className="diagnostic">
                  <h2>{labels[result.status]}</h2>
                  {'diagnostic' in result && (
                    <>
                      <p>{result.diagnostic.message}</p>
                      <code>{result.diagnostic.code}</code>
                      {result.diagnostic.path && <p className="fine">{result.diagnostic.path}</p>}
                    </>
                  )}
                </div>
              )}
            </section>
            <section className="panel counts-panel">
              <h2>Every observation accounted for</h2>
              <div className="counts">
                {(['K', 'E', 'O', 'T'] as const).map((key, i) => (
                  <div key={key}>
                    <span>
                      {['Known requests', 'Known errors', 'SDK overflow', 'Total requests'][i]}{' '}
                      <code>{key}</code>
                    </span>
                    <strong>{valid ? valid[key].toString() : '—'}</strong>
                  </div>
                ))}
              </div>
              <p className="fine">
                Known successes = K − E{valid ? ` = ${valid.K - valid.E}` : ''}. The denominator
                includes overflow.
              </p>
            </section>
            <section className="panel method-panel">
              <h2>Bounds you can check</h2>
              <div className="formula-row">
                <div>
                  <span>LOWER BOUND</span>
                  <code>E / T</code>
                  {valid?.lower && <p>{fraction(valid.lower)}</p>}
                  <p>All overflow requests succeed.</p>
                </div>
                <div>
                  <span>UPPER BOUND</span>
                  <code>(E + O) / T</code>
                  {valid?.upper && <p>{fraction(valid.upper)}</p>}
                  <p>All overflow requests fail.</p>
                </div>
              </div>
              <p>
                These extremes are attainable under the stated assumptions. They describe what is
                possible, not how likely it is. No missing outcome attributes are recovered.
              </p>
              {valid && (
                <p className="fine">
                  Exact threshold fraction: <code>{fraction(valid.threshold)}</code>. Display
                  rounding never affects the verdict.
                </p>
              )}
              <details>
                <summary>When this model applies</summary>
                <p>
                  A synchronous monotonic integer Sum, one complete delta interval or a compatible
                  cumulative pair, and a boolean outcome on every ordinary measurement point.
                </p>
                <p>
                  SDK overflow must have exactly one measurement attribute:{' '}
                  <code>otel.metric.overflow = true</code>. Resource and scope attributes may
                  remain. Cardinality Guardian can add the same marker while preserving measurement
                  attributes; that shape is rejected.
                </p>
                <p>
                  This analysis covers the imported interval. It does not establish a monthly SLO or
                  prove export completeness.
                </p>
              </details>
              <button
                type="button"
                className="export-button"
                disabled={!result || !source || (mode === 'cumulative' && !afterSource)}
                onClick={exportReport}
              >
                Export explanatory JSON <span>↓</span>
              </button>
              <p className="fine">
                Includes exact counts and fractions, identity, interval, assumptions, source SHA-256
                and calculation inputs. Cumulative reports include both source hashes and per-point
                increments.
              </p>
            </section>
          </div>
        </div>
        <footer>
          <span>OverflowLens · Apache-2.0 · v0.2.0</span>
          <span>Your file stays in this browser. No analytics. No remote services.</span>
        </footer>
      </main>
    </>
  );
}
