# SDK validation

The harness validates OverflowLens against **OpenTelemetry Go SDK v1.47.0**, a controlled synchronous integer request counter, and the official OTLP HTTP exporter. It requires no Collector or external backend.

## Reproduce the fixtures

Use Node.js 24.21+, npm and Go 1.26+. Install the pinned npm dependencies if needed, then run from the repository root:

```sh
npm ci
npm run validate:sdk
cd validation
go vet ./...
```

`validate:sdk` regenerates `fixtures/sdk/` and checks the fresh JSON exports through the TypeScript core. Collection timestamps and point order may change; byte equality between runs is not required. Preserve the captured fixture bytes when reviewing or publishing them.

The harness pins the Go SDK, metric API, resource SDK and exporter to v1.47.0, OTLP protobuf to v1.11.0, and the protobuf runtime to v1.36.12. The official exporter sends protobuf to a disposable loopback receiver. Official ProtoJSON converts the captured payloads to JSON with numeric enums. The harness does not construct OTLP JSON from internal SDK structs.

Providers, exporters and receivers are closed on errors. Cumulative cases use a bounded context. Collections are sequential, with no sleeps or periodic timer controlling the workload.

## Workload and ground truth

The selected window records:

- 900 successful requests with one `request.id`;
- 1 failed request with another ID;
- 99 requests with unique IDs, of which 33 fail.

Independent ground truth is **34 errors among 1,000 requests**, or **3.4%**. The manifest records these input observations separately from aggregated points and cumulative baseline observations.

The harness checks the actual exported attribute sets; it does not assume which series an SDK will retain from the configured cardinality limit.

## Delta cases

Each delta case creates a fresh provider with limit 3 and an explicit delta ManualReader. A baseline collection establishes the interval start; the workload precedes the final collection.

The actual exported counts are `K=901, E=1, O=99, T=1000`, giving bounds `1/1000 … 100/1000` and containing the ground truth.

- `within.json`, threshold 10%: `WITHIN_LIMIT`, including upper-bound equality.
- `exceeds.json`, threshold 0%: `EXCEEDS_LIMIT`.
- `indeterminate.json`, threshold 1%: `INDETERMINATE`.

Each case has a `*-view.json` control with a View removing `request.id` and retaining `success`. Those controls give `K=1000, E=34, O=0, T=1000`, exact rate 3.4%.

## Cumulative cases

Each cumulative provider uses `sdk.NewManualReader()` with no temporality override. Before the first snapshot, it records 100 successes with one ID, 7 errors with another, and 5 additional requests. It exports that nonzero baseline, records the 1,000-request workload, exports After, and collects again without new observations.

- `cumulative-before.json` and `cumulative-after.json`: baseline total 112 with overflow 5; window `K=901, E=1, O=99, T=1000`, bounds 0.1%…10%, containing truth 3.4%. The final cumulative total is 1,112, while the window total is 1,000.
- `cumulative-view-before.json` and `cumulative-view-after.json`: the outcome-preserving View gives exact window rate 3.4% with no overflow.
- `cumulative-zero.json` and `cumulative-view-zero.json`: real later collections with unchanged counts, producing `NO_DATA`.
- `cumulative-restart.json` and `cumulative-view-restart.json`: exports from fresh providers with matching metadata and changed starts. Pairing refuses them with `CHANGED_START_TIME`.

All eight cumulative JSON files come from real official exporter payloads. TypeScript tests independently verify serialized increments, baseline exclusion, count conservation, truth containment, View results, zero windows and restart refusal.

## HTTP 5xx histogram validation

`npm run validate:http` runs `validation/http`, which serves a deterministic workload through a real `net/http` server wrapped by **otelhttp v0.72.0** (`otelhttp.NewHandler`). The instrumentation emits the stable `http.server.request.duration` histogram (semantic conventions package `semconv/v1.43.0`, advisory buckets 0.005 … 10 s) beside the request and response body size histograms. The harness records the exact module versions in `fixtures/http/manifest.json`: Go SDK `sdk/metric` v1.47.0, otelhttp v0.72.0, OTLP HTTP exporter v1.47.0, OTLP protobuf v1.11.1 and the protobuf runtime v1.36.12.

Configuration: delta temporality for every instrument kind, the default Histogram aggregation (explicit buckets from the advisory boundaries, min and max recorded) and no Views. A baseline collection precedes the workload, and requests run sequentially against a loopback server. The server is closed before the final collection so every handler has recorded its metrics. No sleeps or periodic timers are used. The official OTLP exporter sends protobuf to a disposable receiver, and official ProtoJSON writes the JSON with numeric enums. The harness does not build OTLP JSON by hand.

The workload has 684 requests: seven fixed attribute sets (clients `alpha` and `beta`, with statuses 200, 201, 404, 500, 502 and 503) followed by 120 requests from unique `test.client` values that add a new attribute set each. The status of each request is chosen by the harness, and the instrumentation records what it serves. Ground truth is independent of the metric: a client tally of completed responses, cross-checked against a server-side tally taken inside the handler. It contains 51 responses with status 500–599.

- `http-overflow.json`: SDK cardinality limit 8. Seven ordinary points and one overflow point give `K=564, E=24, O=120, T=684`, bounds 24/684 … 144/684, and the true 51/684 inside them.
- `http-no-overflow.json`: limit 2,000. The same workload yields 127 ordinary points, `O=0`, `E=51`, and one exact rate 51/684.

Both files contain three streams, so the other histograms test that the name restriction refuses a metric of identical shape. The harness fails if conservation, truth containment or the overflow expectation fails; `tests/http-sdk.test.ts` repeats them against the saved files and the TypeScript core. Port numbers and timestamps change on every run.

## Synthetic controls

Malformed controls alter copies of valid exports to test individual decreases, missing counterparts, stream mismatches and inconsistent collection boundaries. They are test inputs, not SDK-produced fixtures.

Other synthetic controls cover large integer precision, per-series starts, attribute identity order, conflicting definitions, flags, overflow shape, exact threshold equality, deterministic reports and reuse of prepared counts. The mathematical demo and endpoint histories demonstrate information loss; they are distinct from the independently recorded SDK workload.

## Browser and packaging checks

Follow [Contributing](../CONTRIBUTING.md) to run formatting, unit tests, production build and Chromium acceptance. Browser cases cover all three modes, provenance resets, concurrent and replaced Worker imports, refusal reports, source hashes including UTF-8 BOM, exact thresholds and mobile layout.

A synthetic pair with 28,000 series exercises files near the 5 MiB limit. Threshold changes reuse prepared counts, preserve exact results and produce no browser long tasks during the checked interaction. The archive test uses the same packager as the release workflow and verifies launch instructions, checksum, assets and the Worker from the extracted archive.

## Collector pipeline

A separate, explicit lab sends the same workload through a pinned OpenTelemetry Collector and checks the output. See [Collector validation](collector-validation.md) for the pipeline, the preserved and violated assumptions, and the commands. Its Docker steps are not part of `npm run validate:sdk`, unit tests or CI.

## Validation scope

Compatibility evidence covers the pinned Go SDK, one synchronous integer instrument, one otelhttp server histogram workload and Chromium. Mobile layout is checked with a narrow viewport. These checks do not prove production delivery completeness, physical-device performance, cross-SDK behavior or a full SLO. The Collector lab adds one pinned Collector version and configuration; it does not generalize to other processors or deployments.

Report and fixture hashes identify reproducible calculation inputs; they do not prove provenance. See [Design and references](research.md) for the underlying specifications and [Input contract](input-contract.md) for accepted data.
