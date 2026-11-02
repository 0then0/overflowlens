# Collector validation

This lab checks what OverflowLens concludes from OTLP that has passed through a real OpenTelemetry Collector. It extends the [SDK validation](validation.md) without changing the product, the mathematics or the [input contract](input-contract.md).

The result is narrow. One pinned Collector with no processor on the positive path preserved the cumulative request counter, its ordinary and overflow points, and its timestamps. A second Collector that deliberately dropped the overflow points produced a valid file whose bounds do not apply to the original workload. Nothing in that file reveals the loss.

## Pinned pipeline

- Distribution: `otel/opentelemetry-collector-contrib` **0.163.2**, pulled by manifest-list digest `sha256:7f22d2a6748110ffb6a59bc0df448bccbf501cdb667d610ede4c61d3863d5849`. The run was verified on `linux/arm64` under Docker Desktop on macOS; `otelcol-contrib --version` reports `0.163.2`.
- Components, all at module version v0.163.0: `otlp` receiver, `otlp_http` exporter (`otlphttp` is a deprecated alias), `prometheus` exporter, `filter` processor (negative control only) and `health_check` extension.
- Configurations: [`positive.yaml`](../validation/collector/configs/positive.yaml), [`positive-openmetrics.yaml`](../validation/collector/configs/positive-openmetrics.yaml) and [`drop-overflow.yaml`](../validation/collector/configs/drop-overflow.yaml). Their SHA-256 hashes are in the manifest.

Component behavior was taken from the README and source of the v0.163.0 tag, not from `latest`.

```text
Go SDK (cumulative, limit 3)
  → official otlpmetrichttp exporter
  → Collector: otlp receiver → [filter, negative control only] → otlp_http exporter → OTLP sink (Go, host loopback)
                                                              ↘ prometheus exporter → scrape (host loopback)
```

The OTLP sink stores each request body as protobuf. The lab converts those bytes with the official ProtoJSON serializer, using numeric enums as the SDK harness does. It never builds OTLP JSON from SDK structures.

## Safety limits

Everything is disposable and local. Collector ports are published on `127.0.0.1` only, the sink listens on loopback, and there are no credentials, no external backend, no Docker socket and no privileged mode. The container has a read-only root filesystem, all capabilities dropped, `no-new-privileges`, 256 MiB of memory, one CPU, a 128-process limit and exactly one read-only mount (its configuration). The lab asserts this configuration after starting the container.

The whole run has a 3-minute deadline and each wait has a 20-second deadline. The sink accepts at most 8 exports of at most 1 MiB, scrapes are limited to 1 MiB, and container logs are truncated. Each scenario makes exactly four exports. The container, listeners and temporary directory are removed on success, on error and on SIGINT/SIGTERM. Containers carry the label `overflowlens.lab=collector`, so a leftover from a killed process can be found with `docker ps -a --filter label=overflowlens.lab=collector`.

Tool preparation is a separate, explicit step. Unit tests, browser tests and the application download nothing. `run` uses `--pull=never` and fails with an instruction if the image is absent.

## Reproduce

Use the toolchain from [Contributing](../CONTRIBUTING.md), plus Docker.

```sh
npm run validate:collector:prepare
```

This pulls the pinned digest and is the only network step. Then verify the pipeline without writing evidence:

```sh
npm run validate:collector
```

The run executes all three Collector configurations, checks every assertion below and compares the semantic content of the fresh run with `fixtures/collector/manifest.json`. Timestamps, container identifiers and run metadata are in the manifest's `provenance` section and are not compared, so the comparison is stable across runs.

To capture new evidence, write it to a directory. The lab refuses to overwrite existing evidence unless asked:

```sh
npm run validate:collector -- --out ../fixtures/collector --replace
OVERFLOWLENS_WRITE_ANALYSIS=1 npx vitest run tests/collector.test.ts
```

The second command regenerates `analysis.json`, the recorded product results. Review replaced evidence as captured output. Then run the ordinary checks, which read the committed evidence only:

```sh
npm test
npm run build
npm run test:browser
```

The Docker lab is not part of `npm test` or CI. The `go vet ./...` step in `validation/` covers its source. It was verified under Docker Desktop on macOS. The Collector reaches the sink at `host.docker.internal`, which Docker Desktop forwards to host loopback; other Docker setups were not tried.

## Workload and ground truth

The workload and counter configuration match the SDK harness: 900 successes and 1 error with known IDs, and 99 unique requests of which 33 fail. Truth is 34 errors in 1,000 requests, 3.4%. A baseline of 100 successes, 7 errors and 5 further requests is recorded before the first snapshot, so the cumulative totals are 112 before and 1,112 after. The manifest records the observations independently of any exported point. A test checks that they equal the SDK harness manifest.

The retained series are whatever the SDK exported. The lab classifies the actual exported points and checks conservation (`T` equals the truth total, `E ≤ truth errors ≤ E + O`). It does not assume which attribute sets survive the limit.

Each scenario makes four acknowledged exports: Before, After, a collection with no new observations (Zero), and an exact re-delivery of After. After each export the lab waits for the SDK exporter result and for the sink to hold that export, then scrapes. Scrapes of Before and After are repeated.

## Positive pipeline

The positive configuration has no processor. The SDK's default reader emits cumulative sums and the Collector forwards them unchanged, so no temporality converter was needed or used.

Checked on the real output of the sink:

- **Identity and temporality:** one stream; Resource, scope, metric name, unit and monotonicity equal the SDK's; temporality is cumulative.
- **Timestamps:** every point's start and collection time equals the SDK's value. Starts are equal across exports and collection times increase.
- **Points:** the set of attribute sets and every count equals the SDK's, including the overflow point. Nothing disappeared, merged or appeared.
- **Window:** from the Before and After exports, `K=901, E=1, O=99, T=1000`. The window excludes the baseline: snapshot totals are 112 and 1,112, the window is 1,000. The bounds are 0.1%…10% and contain 3.4%.
- **Thresholds:** 0% gives `EXCEEDS_LIMIT`, 1% `INDETERMINATE`, 10% `WITHIN_LIMIT`.
- **No new observations:** After→Zero gives `NO_DATA`. The re-delivered After snapshot is identical to After, and no count is added.

The product reaches the same numbers through the TypeScript core and, in Chromium, through the UI. See `tests/collector.test.ts` and `tests/browser/collector.spec.ts`.

## Prometheus evidence channel

The Prometheus exporter is a second view of the same pipeline, not an input format. The lab reads only the selected counter family with a small strict line reader that fails on anything it does not understand. It is lab code in `validation/collector/prom.go`, not a Prometheus or OpenMetrics parser. The test suite has an equally narrow line filter.

Observed with the default exporter (classic text):

- **Content type:** `text/plain; version=0.0.4; charset=utf-8; escaping=underscores`. An OpenMetrics `Accept` header did not change it, because `enable_open_metrics` is off by default.
- **Family:** `http_server_requests_total`, type `counter`. The unit `{request}` produced no suffix.
- **Label translation:** `request.id` became `request_id`, `success` stayed `success`, and the overflow marker became **`otel_metric_overflow="true"`** on its own sample, with no `request_id` or `success`.
- **Resource and scope labels:** `job` (from `service.name`), `instance` (from `service.instance.id`), `otel_scope_name`, `otel_scope_version` and `otel_scope_schema_url` (empty). Other Resource attributes appear only in `target_info`, a gauge with value 1. The lab excludes it, and `_created`, bucket and any other sample, by requiring an exact family-name match.

With `enable_open_metrics: true` and an OpenMetrics `Accept` header, the content type is `application/openmetrics-text; version=1.0.0; charset=utf-8; escaping=underscores`. The family is declared as `http_server_requests`, the sample is `http_server_requests_total`, values print as `104.0`, and there is a trailing `# EOF`. The labels are the same. A classic `Accept` header against that exporter still gets classic text.

The counts agree with OTLP and the workload at every boundary: Before totals 112, After totals 1,112 with 104 in the overflow series (5 baseline plus 99), Zero and the re-delivered After stay at 1,112, and a repeated scrape returns the same exposition. A scrape is not an event. Repeating it or re-delivering an export does not add counts.

The exporter source for v0.163.0 shows that it also accepts monotonic delta sums and converts them internally, but only for contiguous intervals. It refuses non-monotonic delta sums. This was read, not exercised. The lab keeps both outputs on cumulative data, so no hidden converter is involved.

## Negative control: overflow dropped downstream

`drop-overflow.yaml` adds one `filter` processor with `error_mode: propagate`. Its single condition drops data points of `http.server.requests` where `otel.metric.overflow` is `true`. The pipeline is otherwise the same.

What the lab observed:

- The receiver got three real exports with no overflow point. The SDK had produced overflow values 5, 104 and 104 in Before, After and Zero. Those three points are the only difference between the SDK's output and the sink's, and the lab asserts it.
- The ordinary points kept their counts and timestamps (known-success 1,000, known-error 8 at After).
- Window arithmetic on the filtered file gives `K=901, E=1, O=0, T=901`, an exact rate of 1/901 ≈ 0.111%, with no diagnostics. At 0% the verdict is `EXCEEDS_LIMIT`; at 1% and 10% it is `WITHIN_LIMIT`.

The mathematical result and the provenance fact are separate.

- **Mathematics, under the confirmed assumptions.** For 901 received requests with one error and no overflow, 1/901 is exact. This is not an arithmetic defect.
- **Provenance, known only from the lab.** The file is not a complete SDK export. The original workload had 1,000 requests and a rate of 3.4%. That rate is outside the computed bounds, and at a 1% limit the file says `WITHIN_LIMIT` while the truth exceeds it. The loss left no trace. The missing overflow marker is not evidence of integrity or of loss, and OverflowLens does not infer either. The provenance confirmation exists for this case, and the application cannot check pipeline completeness.

## Assumptions

Preserved by the positive pipeline, for this Collector and configuration: complete export of the selected counter, one continuous source history, unchanged per-series starts, unchanged counts and attribution including the overflow point, and cumulative temporality.

Violated by the negative control: no downstream change to counts or measurement attribution. Only the controlled lab knew.

## Evidence

[`fixtures/collector/`](../fixtures/collector/manifest.json) holds about 170 KiB:

- `manifest.json`: pinned image and configuration hashes, runtime provenance, ground-truth workload, semantic results, and SHA-256 of every artifact.
- `<scenario>-before|after|zero.pb` and `.json`: the sink's raw protobuf and its ProtoJSON, for `positive` and `drop-overflow`. The lab converts the same bytes, so the JSON is not constructed separately.
- `<scenario>-prometheus-*.prom`: scrape bodies at the acknowledged boundaries. Content types are in the manifest, and `positive-openmetrics` holds the OpenMetrics variant.
- `analysis.json`: OverflowLens statuses, counts and bounds for the captured files.

Images, binaries and full runtime logs are not committed. Protobuf bytes, JSON text, point order and timestamps may differ between captures, and the checks do not require byte equality.

## Scope

This is evidence for one Collector version and configuration, one SDK and one synchronous integer counter. It does not show that other processors (batching, aggregation, attribute or resource transformations), exporters, versions or deployments preserve the contract. It does not add a Prometheus or OpenMetrics input, a live Collector connection, multi-process aggregation or a general temporality converter.
