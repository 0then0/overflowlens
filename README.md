<p align="center"><img src="public/icon.svg" width="96" height="96" alt="OverflowLens: a lens over a range of possible error rates" /></p>

# OverflowLens

[![License](https://img.shields.io/badge/license-Apache--2.0-426449)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/0then0/overflowlens/ci.yml?branch=main&label=checks)](https://github.com/0then0/overflowlens/actions/workflows/ci.yml)
[![Validated SDK](https://img.shields.io/badge/validated%20SDK-Go%201.47.0-426449)](docs/validation.md)

OverflowLens calculates **exact error-rate bounds after OpenTelemetry SDK cardinality overflow**. Open a local OTLP metrics export, select a request counter and collection interval, and compare every compatible error rate with your limit.

The application runs entirely in your browser. Imported files stay on your computer. There are no accounts, analytics, remote fonts or external application requests. The README badges are external images; they are not loaded by the application.

## Why error-rate bounds?

An SDK cardinality limit can preserve request counts while replacing measurement attributes with `otel.metric.overflow=true`. A query filtered by `success=false` then sees only the errors whose outcomes survived. The overflow count remains in the total, but its outcomes are unknown.

For example:

```text
Known successes                 900
Known errors                      1
SDK overflow                     99
Total                         1,000

Possible true error rate       0.1% … 10%
Maximum allowed error rate       1%
Conclusion: Cannot determine from these data
```

All 99 overflow requests could have succeeded, failed, or had any mixture of outcomes. OverflowLens reports the attainable bounds without guessing outcomes or assigning probabilities.

## Quick start

Requires Node.js 24.21+ and npm. Go is only needed to reproduce the SDK validation experiment.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite:

1. Load the built-in example or choose an OTLP JSON file.
2. Select one metric stream and one collection interval.
3. Enter the boolean outcome attribute, such as `success`, and choose which value means error.
4. Confirm the data provenance contract after checking that it applies to your export.
5. Set the maximum allowed error percentage. Equality meets the limit.
6. Export the explanatory JSON to retain the exact inputs, bounds and conclusion.

The outcome key can be entered manually, including for an overflow-only interval. Changing the file, stream, interval or outcome clears dependent settings and requires a new provenance confirmation.

## Understand the result

- **Within limit**: every error rate compatible with the imported interval meets your limit.
- **Exceeds limit**: every compatible error rate exceeds your limit.
- **Cannot determine**: some compatible rates meet the limit and others exceed it.
- **No observations**: the valid interval totals zero, so no error rate is defined.
- **Invalid input / Unsupported input**: the data or assumptions do not support this calculation. Read the diagnostic before changing the input.

Malformed related data blocks a conclusion rather than silently reducing the selected stream's counts. Independent unsupported metrics do not invalidate a valid selection. See the [input contract](docs/input-contract.md) for the exact rules.

## Supported data

Version 0.1 accepts uncompressed UTF-8 OTLP JSON `ExportMetricsServiceRequest` files up to **5 MiB**, using lowerCamelCase field names and numeric enum values. It analyzes one Resource/scope/metric group and one complete interval of a synchronous request counter represented as a monotonic, integer, delta `Sum`.

The provenance confirmation means you assert that the interval is a complete SDK export, each observation counts requests from a synchronous instrument, every request has one boolean outcome, and no downstream transformation changed counts or measurement attributes. JSON structure alone cannot prove these conditions.

Ordinary points must retain the chosen boolean measurement outcome. Resource and scope attributes are separate and cannot supply it. An SDK overflow point must have exactly one measurement attribute: `otel.metric.overflow=true`. Additional attributes make the point ambiguous, including [Cardinality Guardian](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/cardinalityguardianprocessor) `tag_only` output.

The importer preserves stream identity, normalizes attribute order and equivalent byte encodings, and rejects conflicting definitions, duplicate measurement identities and overlapping unequal intervals. Decimal-string and numeric integer tokens are read without precision loss; fractional and exponent forms of integer fields are intentionally unsupported.

OverflowLens analyzes one imported interval. It does not verify a full SLO, recover lost outcomes, query Prometheus or Grafana, convert cumulative counters, analyze histograms, or establish delivery completeness.

## Exact arithmetic and exported reports

For ordinary count `K`, known errors `E`, overflow count `O`, and total `T = K + O`:

```text
lower = E / T
upper = (E + O) / T
upper <= limit  → WITHIN_LIMIT
lower > limit   → EXCEEDS_LIMIT
otherwise       → INDETERMINATE
T = 0           → NO_DATA
```

Counts and comparisons use `BigInt`. The percentage limit is converted to an exact fraction. Only displayed percentages and chart positions are approximate; rounded endpoints never determine the conclusion.

The exported report preserves decimal-string counts and fractions, source SHA-256, stream identity, exact nanosecond boundaries, settings, assumptions, point counts and attainable endpoint witnesses. It uses the same calculation as the UI. A source hash identifies bytes, not provenance. Read the [mathematical model](docs/mathematics.md) for the proof.

## Development and checks

Dependencies are pinned in `package-lock.json`.

```sh
npm run check
npm test
npm run build
npm run preview
```

The static application is built into `dist/`, including its Worker, icon and examples. Serve this directory over HTTP or HTTPS; `file://` is unsupported. Relative asset URLs support hosting in a subdirectory. These commands build and preview locally; CI uploads a build artifact.

Browser tests use the built application:

```sh
npx playwright install chromium
npm run test:browser
```

[Biome](https://biomejs.dev/) 2.5.15 provides formatting, recommended lint rules and import organization. Formatting uses two spaces, LF, a 100-column line width and single quotes in JavaScript/TypeScript. Warnings fail checks.

```sh
npm run format        # Apply formatting
npm run format:check  # Check formatting without editing
npm run lint          # Lint without editing
npm run check         # Check formatting, lint and import organization
npm run check:fix     # Apply formatting and safe automatic fixes
```

Biome respects `.gitignore`. SDK fixtures, example exports and `package-lock.json` are excluded to preserve recorded bytes. Markdown and workflow YAML are maintained separately; Go uses `gofmt` and `go vet`.

To regenerate SDK fixtures, install Go 1.26+ and run:

```sh
npm run validate:sdk
```

This command captures an official Go SDK export through an ephemeral loopback receiver, rewrites `fixtures/sdk/`, and verifies the fresh fixtures with the TypeScript core. Timestamps and point order may change. The [SDK validation guide](docs/validation.md) explains the workload, ground truth and expected results.

## Documentation and source layout

- [Input contract](docs/input-contract.md): accepted representations, identity, diagnostics and report format.
- [Mathematics](docs/mathematics.md): sharp bounds, threshold decisions and exact arithmetic.
- [SDK validation](docs/validation.md): reproduce the pinned Go SDK experiment.
- [Design and references](docs/research.md): OpenTelemetry semantics and primary sources.
- `src/core/`: parsing, normalization, applicability, calculation and reports, independent of React.
- `src/App.tsx`, `src/styles.css`, `src/import.worker.ts`: browser UI and background import.
- `tests/`: unit, exhaustive small-count, import regression, SDK and browser tests.
- `validation/`, `fixtures/sdk/`: Go harness, real SDK exports and ground truth manifest.
- `public/examples/`: synthetic examples, including the built-in demonstration.

Licensed under [Apache-2.0](LICENSE). Bundled libraries retain their licenses in [third-party notices](public/third-party-notices.txt).
