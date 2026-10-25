# Contributing to OverflowLens

OverflowLens is a static browser application. Its core parses and analyzes saved OTLP exports independently of React. Keep changes within that model and preserve exact arithmetic, conservative refusals and local processing.

## Issues and pull requests

Use the repository's bug or feature issue form. Include a release or commit, reproduction steps and a minimal synthetic export for bugs. Follow the [code of conduct](CODE_OF_CONDUCT.md) and use the [security reporting process](SECURITY.md) for potential vulnerabilities. Do not publish private telemetry.

Keep pull requests focused, complete the PR template and state which checks you ran. Update the [changelog](CHANGELOG.md) for user-visible changes. Application behavior, report schemas and supported inputs need matching documentation and meaningful regression coverage.

## Development environment

Use Node.js 24.21+ and npm with the checked-in `package-lock.json`:

```sh
npm ci
npm run dev
```

Python 3 is needed for static release packaging and its tests. Go 1.26+ is needed only to regenerate SDK fixtures. The harness dependencies are pinned in `validation/go.mod` and `validation/go.sum`.

## Source layout

- `src/core/`: lossless parsing, normalization, applicability, exact calculation and reports.
- `src/App.tsx`, `src/styles.css`: controls, state, presentation and responsive layout.
- `src/import.worker.ts`: background parsing and normalization of local files.
- `public/examples/`: synthetic examples bundled with the application.
- `tests/`: core, import, SDK fixture and documentation tests.
- `tests/browser/`: production-build acceptance, responsiveness and archive tests.
- `validation/`, `fixtures/sdk/`: Go SDK harness, real exports and ground truth manifest.
- `scripts/package-release.py`: the packager shared by local builds, browser tests and the release workflow.

Keep parsing, applicability, calculation and presentation separate. Cumulative matching prepares the selected window's increments and totals; threshold or provenance changes reuse that preparation. File, stream, boundary or outcome changes must invalidate dependent selections and confirmation.

## Checks

Run these from the repository root:

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Browser tests use the production build through a local preview server. They also package the build in a temporary directory and run the extracted archive, checking assets and the import Worker. The large-window regression checks threshold changes on a synthetic pair near the importer limit; it checks correctness and browser long tasks rather than elapsed network or process time.

For Go changes or SDK validation:

```sh
npm run validate:sdk
cd validation
go vet ./...
```

`validate:sdk` rewrites SDK fixtures. Run it separately from tests that read those files. Review those changes as captured exports, preserving their bytes. See [SDK validation](docs/validation.md) for expected results and the distinction between real exports and synthetic controls.

## Dependency updates

[Dependabot](.github/dependabot.yml) checks npm packages, the Go validation harness and GitHub Actions on the first day of each month at 10:00 Europe/Moscow. Version updates wait at least seven days after publication. Minor and patch updates are grouped into one PR per ecosystem, with at most three regular dependency PRs open across the repository. Major upgrades are reviewed and applied manually. Updates require review and passing CI; they are not automatically merged.

For Go SDK updates, regenerate and review the fixtures with `npm run validate:sdk`, and update the documented SDK version and validation results as needed. A dependency-only change does not establish compatibility with a new SDK version.

Dependabot security updates, when enabled in the repository settings, use a separate schedule and PR limit. The monthly schedule and cooldown do not delay them. Ignore rules still apply; review security fixes that require a major upgrade manually. See the [GitHub configuration reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) for these distinctions.

## Formatting and conventions

Biome checks formatting, recommended lint rules and import organization. Use two spaces, LF, single quotes in JavaScript/TypeScript, and a 100-column line width. Warnings fail checks.

```sh
npm run format
npm run format:check
npm run lint
npm run check:fix
```

Fixtures, bundled examples and `package-lock.json` are excluded from Biome to preserve recorded bytes. Markdown and workflow YAML are maintained separately. Format Go with `gofmt`.

`.editorconfig` defines editor defaults, including Go tabs and Python's four-space indentation. `.gitattributes` normalizes ordinary text to LF and marks binary assets appropriately. Captured SDK fixtures and bundled JSON examples are excluded from Git line-ending conversion and editor whitespace cleanup so their original bytes remain intact. Do not normalize or reformat them as part of unrelated work. Keep lockfiles, fixtures and screenshots tracked; `.gitignore` excludes dependencies, builds, local configuration and verification artifacts.

Use Conventional Commits in English with `feat`, `fix`, `refactor`, `chore`, `docs` or `test`. Describe behavior and verification in pull requests. Add tests for meaningful regressions; do not replace exact comparisons with rounded display values or treat missing points as zero.

## Package a build

After checks and a production build:

```sh
npm run package:release
```

The packager creates `release/overflowlens-<version>.zip` and `release/SHA256SUMS.txt`. Application files are placed directly in the archive's versioned directory, together with the license, launch instructions and release notes. It does not publish anything.

To choose a different output directory or repository for documentation links:

```sh
npm run package:release -- --output-dir /tmp/overflowlens-release --repository owner/overflowlens
```

Update the package version, lockfile metadata and versioned release notes together. The tagged release workflow verifies the tag against `package.json`, runs checks and browser acceptance, invokes this same packager, and publishes the ZIP and checksum. Its launch instructions use the extracted archive root; source-build instructions use `dist/`.
