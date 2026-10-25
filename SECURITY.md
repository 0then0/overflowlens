# Security policy

## Supported versions

Security fixes target the latest published release and the default branch. Older releases do not receive separate backports. Use the latest release from [GitHub Releases](https://github.com/0then0/overflowlens/releases).

## Reporting a vulnerability

Do not publish exploit details, sensitive telemetry, credentials or original private exports in issues or pull requests.

If the repository's [security advisory page](https://github.com/0then0/overflowlens/security/advisories) offers **Report a vulnerability**, use that private channel. Otherwise, open an issue titled **Request for private security contact**, containing only a request for a confidential reporting channel. Wait for the maintainer to arrange that channel before sharing details. GitHub private vulnerability reporting is not currently enabled for this repository.

A private report should include the affected release or commit, reproduction steps with synthetic data, expected and observed behavior, impact, and any suggested fix. Browser, operating system and hosting details help diagnose isolation or file-handling problems. Disclosure timing is agreed with the reporter; this project does not promise a fixed response time or a bounty.

## Security model

OverflowLens processes imported exports locally in a browser Worker. The application has no backend, accounts, uploads, analytics or external application requests. README badges are external images loaded by the documentation viewer. Hosting providers and browser extensions operate outside the application's control.

Treat exports and generated reports as potentially sensitive: they can include Resource attributes, stream identities, timestamps and file names. Source SHA-256 hashes identify bytes; they do not authenticate the source or prove completeness. Imported metadata cannot prove the provenance assumptions required by the calculation.

Use a trusted browser and trusted build, serve the application over loopback HTTP or HTTPS, and verify downloaded release archives against their published checksum. A checksum alone does not establish publisher authenticity. Input limits and conservative refusals are described in the [input contract](docs/input-contract.md).
