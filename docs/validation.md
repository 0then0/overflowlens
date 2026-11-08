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

## Cumulative HTTP 5xx window validation

`npm run validate:http-cumulative` runs `go run ./http cumulative`, then `tests/http-cumulative-sdk.test.ts`. It uses the same real otelhttp v0.72.0 server as the delta harness, with the SDK default: `sdk.NewManualReader()` without a temporality selector (cumulative for every instrument), the default Histogram aggregation, no Views and an explicit **cardinality limit of 8**. The versions, settings, commands, workload plans, source SHA-256 of the harness files and the SHA-256 and size of each OTLP file are recorded in `fixtures/http/cumulative-manifest.json`. As elsewhere, the official exporter's protobuf is converted by official ProtoJSON; the JSON is never built by hand.

Sequence, on one loopback server whose address and port stay stable:

1. Before the first snapshot, 216 requests: seven fixed ordinary series (clients `alpha` and `beta`, statuses 200, 201, 404, 500, 502, 503) plus 40 unique clients that overflow. Export `http-cumulative-before.json`.
2. A deterministic window workload of 551 requests: the seven retained series, known clients with new statuses (new attribute sets overflow), and 100 unique clients. Every response is counted independently by the client and cross-checked by a server-side tally. A barrier waits for every handler, including the metric recording. Export `http-cumulative-after.json`.
3. A third collection without new requests: `http-cumulative-zero.json`.
4. A restarted SDK: a new provider serves the baseline and the window workload again on the same server. Its series are identical and every count is at least the first snapshot's, so only the changed start times reveal the restart: `http-cumulative-restart.json`.

The harness differences the SDK structs independently of the JSON: 767 requests at the second snapshot minus 216 at the first give the 551-request window, with `K=446, E=21, O=105`, bounds 21/551 … 126/551 (≈3.81% … ≈22.87%), containing the true 49/551 (≈8.89%). Overflow is present at both snapshots, the series set is identical, and the harness fails if conservation, containment or the restart properties fail.

The TypeScript test repeats these checks against the saved files: hashes, tallies, window counts, truth containment, baseline exclusion, the zero window (`NO_DATA`) and the restart refusal (`CHANGED_START_TIME`, although a count-only comparison would accept the pair). The browser spec opens the pair, checks the counts, changes the threshold, exports the report and checks the exact truth containment from the exported fractions. Port numbers and timestamps change on every run.

## Route slow-share validation

`npm run validate:http-route` runs `go run ./http route`, then `tests/http-route-sdk.test.ts`. It uses the pinned SDK of the other harnesses (`sdk/metric` v1.47.0, metric API v1.47.0, the OTLP HTTP exporter and ProtoJSON), a real SDK `Float64Histogram` named `http.server.request.duration` with unit `s`, explicit boundaries 0.1, 0.25, 0.5, 1 and 2.5 s, delta temporality and no Views. Known duration values are recorded **directly through the Metric API**, with no HTTP server, no timing and no waiting. This validates SDK aggregation and the arithmetic; it is not a measurement of real HTTP latency, and the case is the project's own validation, not external adoption. Versions, the plan and an independent per-attribute-set journal are in `fixtures/http/route-manifest.json`.

The harness keeps a journal of (route, method, duration) before each value reaches the SDK, classifies each value into its bucket independently of the SDK, and checks that every retained series equals its journal and that the overflow equals the journal of every attribute set the SDK did not retain. Attributes are `http.route` and `http.request.method`; the selected route is `/checkout` and the duration boundary is 0.5 s.

- `route-overflow.json`, cardinality limit 5: `/checkout` GET is retained (`K=400`, `E=10`); `/checkout` POST and other routes arrive after the limit, so the overflow holds fast and slow observations of several routes, including the selected one: `F=194`, `S=31`. Bounds 10/594 … 41/431 (≈1.68% … ≈9.51%) contain the true 20/500 (4%) strictly inside. Observations exactly at 0.5 s are in the workload and are counted as fast.
- `route-no-overflow.json`, limit 2,000: the same workload without overflow gives `K=500`, `E=20` and one exact share 20/500.
- `route-absent.json`, limit 5: every `/checkout` request arrives after the limit, so the route has no ordinary point (`K=0`) although 500 of its requests are in the overflow. The result is `NO_ROUTE_OBSERVATIONS`.

The harness fails if conservation, the overflow split or truth containment fails. Timestamps change on every run.

## Synthetic controls

Synthetic route slow-share inputs cover missing and invalid routes, absent buckets, unmatched boundaries, other units and temporalities, values above the safe integer range, exact threshold equality and the exhaustive assignment check. Malformed controls alter copies of valid exports to test cumulative HTTP windows (reordered points and attributes, integers above int64, zero increments, exact threshold equality, changed starts, decreasing counts, mismatched series, changed bucket layout and corrupt points) and individual decreases, missing counterparts, stream mismatches and inconsistent collection boundaries. They are test inputs, not SDK-produced fixtures.

Other synthetic controls cover large integer precision, per-series starts, attribute identity order, conflicting definitions, flags, overflow shape, exact threshold equality, deterministic reports and reuse of prepared counts. The mathematical demo and endpoint histories demonstrate information loss; they are distinct from the independently recorded SDK workload.

## Browser and packaging checks

Follow [Contributing](../CONTRIBUTING.md) to run formatting, unit tests, production build and Chromium acceptance. Browser cases cover all modes, the route flow with a real SDK export, provenance resets, concurrent and replaced Worker imports, refusal reports, source hashes including UTF-8 BOM, exact thresholds and mobile layout.

A synthetic pair with 28,000 series exercises files near the 5 MiB limit. Threshold changes reuse prepared counts, preserve exact results and produce no browser long tasks during the checked interaction. The archive test uses the same packager as the release workflow and verifies launch instructions, checksum, assets and the Worker from the extracted archive.

## Collector pipeline

A separate, explicit lab sends the same workload through a pinned OpenTelemetry Collector and checks the output. See [Collector validation](collector-validation.md) for the pipeline, the preserved and violated assumptions, and the commands. Its Docker steps are not part of `npm run validate:sdk`, unit tests or CI.

## Validation scope

Compatibility evidence covers the pinned Go SDK, one synchronous integer instrument, one otelhttp server histogram workload and Chromium. Mobile layout is checked with a narrow viewport. These checks do not prove production delivery completeness, physical-device performance, cross-SDK behavior or a full SLO. The Collector lab adds one pinned Collector version and configuration; it does not generalize to other processors or deployments.

Report and fixture hashes identify reproducible calculation inputs; they do not prove provenance. See [Design and references](research.md) for the underlying specifications and [Input contract](input-contract.md) for accepted data.
