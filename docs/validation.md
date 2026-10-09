# SDK validation

This guide explains how to reproduce the Go SDK experiment and interpret its fixtures. The validated SDK is **Go OpenTelemetry v1.47.0**. Compatibility with other SDKs or Collector transformations is outside this experiment.

## Run the checks

Install Node.js 24.21+, npm and Go 1.26+. From the repository root:

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run validate:sdk
cd validation
go vet ./...
```

`npm run validate:sdk` regenerates `fixtures/sdk/` and then checks the fresh exports with the TypeScript core. It uses an ephemeral loopback HTTP receiver and does not need a running Collector or remote backend. Regeneration changes collection timestamps and may change point order; fixture byte equality is not the acceptance criterion.

The web dependencies are pinned in `package-lock.json`. The harness pins the Go SDK, metric API, resource SDK and OTLP HTTP exporter to v1.47.0, OTLP protobuf to v1.11.0, and the protobuf runtime to v1.36.12 in `validation/go.mod` and `go.sum`. CI uses Go 1.27.1 and Node.js 24.

## Workload and independent ground truth

Each case creates a fresh provider with cardinality limit 3 and an explicit delta ManualReader. A baseline collection establishes the interval start. The workload runs between that baseline and a final collection, without depending on a timer or sleep.

The workload records:

- 900 successful requests with one `request.id`;
- 1 failed request with another `request.id`;
- 99 requests with unique IDs, of which 33 fail.

Ground truth is **34 errors among 1,000 requests**, or **3.4%**. The manifest records the input observations independently of the aggregated points.

The official OTLP HTTP exporter serializes the collected SDK data as protobuf. The local receiver captures that payload, and the official `protojson` serializer converts it to JSON with `UseEnumNumbers:true`. The harness does not implement its own metric-to-OTLP mapping.

## Expected results

Without a View, the pinned SDK emits two ordinary points and one overflow point:

```text
K = 901, E = 1, O = 99, T = 1000
Possible error rate: 0.1% … 10%
Ground truth: 3.4%
```

The three fixtures exercise every nonempty mathematical conclusion:

- `within.json`, limit 10%: `WITHIN_LIMIT`, including upper-bound equality.
- `exceeds.json`, limit 0%: `EXCEEDS_LIMIT`.
- `indeterminate.json`, limit 1%: `INDETERMINATE`.

Each case is repeated with a View that removes `request.id` and retains `success`. The View fixtures have `K=1000`, `E=34`, `O=0`, `T=1000`; their exact error rate is 3.4%. At limits 10%, 0% and 1%, the conclusions are respectively within, exceeds and exceeds.

The harness checks count conservation, ground-truth containment, the SDK overflow attribute shape and the expected verdict. The TypeScript SDK tests independently verify the serialized fixtures. The core does not assume which ordinary attribute combinations a different SDK will retain.

## Application regression coverage

Unit tests cover exact bounds, threshold equality, zero totals, large integers, malformed inputs, stream identity and refusals. A bounded exhaustive test evaluates every overflow-error allocation for `K=0..7`, `E=0..K`, `O=0..7` and thresholds `0/10..10/10`.

Import regressions cover equivalent base64 encodings, invalid bytes, quoted double attributes, inherited metadata, Worker cloning, and malformed repeated Resource/scope records. They also check that independent recognized streams remain usable.

Chromium acceptance tests cover the complete example flow, file and selection resets, real SDK import, numeric int64 transfer, refusal reports, quoted double attributes, absence of external application requests and mobile layout. They run against the production build.

## Validation scope

The reference validation environment is macOS arm64 with Node.js 24.21.0, npm 11.19.0, Go 1.27.1 and Playwright Chromium. The experiment covers one synchronous integer instrument, one pinned SDK and a controlled workload. It does not establish production delivery completeness, compatibility with every browser, cross-SDK behavior or a full SLO.

The reference check on 2026-10-09 passed 115 unit and SDK fixture tests, 11 Chromium acceptance tests, Biome checks, TypeScript checking, the production build and `go vet`. All six saved SDK cases passed, including the ground-truth containment checks. These results describe the checked versions and environment, rather than a guarantee for other SDKs or browsers.

The two histories in [mathematics](mathematics.md) demonstrate information loss within the model; they are not separate SDK runs producing byte-identical exports. Fixtures and report hashes provide reproducible calculation inputs, not provenance proofs. See [design and references](research.md) for the underlying specification.
