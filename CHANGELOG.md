# Changelog

This file summarizes user-visible changes. Detailed compatibility and launch instructions are in the linked release notes. Unreleased changes are available on the default branch and are not included in existing release archives.

## Unreleased

- Add high-resolution screenshots of delta and cumulative analysis to the README.
- Configure monthly grouped Dependabot updates with a seven-day cooldown and limited open PRs.
- Add editor and Git conventions, contribution templates, community rules and a security reporting policy.
- Bound CI execution time and cancel superseded checks on the same branch or pull request.

## [0.2.0](docs/releases/v0.2.0.md)

- Analyze windows between two cumulative snapshots using exact per-point increments.
- Check stream identity, collection boundaries, unchanged starts and nondecreasing counts before calculating a window.
- Export schema v2 reports with both source hashes, pair applicability and per-point evidence; preserve delta schema v1.
- Validate cumulative windows, zero increments and restarted providers with the official Go SDK.
- Reuse validated counts for threshold changes and package release archives through a shared local/CI command.

## [0.1.0](docs/releases/v0.1.0.md)

- Import local OTLP JSON integer delta request counters.
- Calculate attainable error-rate bounds after SDK cardinality overflow and compare them with an exact threshold.
- Export explanatory JSON with counts, fractions, assumptions and source SHA-256.
- Validate parsing, conservative refusals and real Go SDK exports.
