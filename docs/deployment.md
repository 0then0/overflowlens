# GitHub Pages distribution

Public app: https://0then0.github.io/overflowlens/.

Published on 2026-11-02 from distribution commit
`6e68396b5b4f28daa3adc34111689b4a6080e38d`, application version 0.2.1.
[Deployment run](https://github.com/0then0/overflowlens/actions/runs/41475058436)
succeeded. The live HTTPS smoke test passed for delta and cumulative examples,
a synthetic local import, threshold changes, Worker loading and JSON exports.
Network interception observed only application assets, with no fetch, XHR,
WebSocket or sendBeacon calls during analysis and export.

Before deployment on 2026-11-02, the URL returned HTTP 404, repository metadata had `has_pages: false`
and an empty homepage, and the Pages API returned 404. No remote setting or deployment
was changed during local preparation.

## Source policy

The Pages workflow is manual only. Pushes and tags do not replace the public app.
Enter a full, reviewed 40-character source commit SHA and a published stable application
version, initially `0.2.1`. The workflow verifies that the version has a non-draft,
non-prerelease GitHub release; its tag is an ancestor of the chosen source; and the
manifest and lockfile match. It also requires the released core, import Worker and
package files to be unchanged from that release. It installs with `npm ci`, runs
checks, tests, the production build and browser acceptance before uploading the
official Pages artifact. Only the deployment job can write Pages or request an OIDC token.
All Actions are pinned to full commit SHAs, and both jobs have finite timeouts.

The first source is a reviewed distribution commit based on released v0.2.1
(`b99ed69b9bdc73566d34426ec20c73a88ae98dd2`), containing the Pages workflow and
bundled cumulative example. It is **not** a new tagged release and does not replace
the existing v0.2.1 archive. The application version remains 0.2.1; the deployed
`deployment.json` records the exact distribution source separately.
A bare v0.2.1 tag predates this distribution preparation and lacks its cumulative
example button and Pages acceptance test. The workflow requires that test file and
refuses the old tag as a distribution source.

Future deployments follow the same explicit SHA policy. Core or dependency changes
must first belong to a published stable version. Never treat a dirty working tree
or a branch name as a release ref. No deployment branch is needed.

## Local verification

```sh
npm run check
npm test
npm run build
npm run test:browser
```

The Pages browser test serves `dist/` strictly under `/overflowlens/`, returning
404 for root-domain asset paths. It exercises examples, local imports, threshold
changes, refusals, JSON downloads, Worker requests, refresh, mobile and system themes.
Network interception checks requests and fetch, XHR, WebSocket and sendBeacon calls.
Only application asset downloads are expected, including the Worker when importing.
The archive test separately packages and serves the extracted build at its root.
`base: './'` is intentionally retained so both distributions use relative assets.
There is no service worker, telemetry or update mechanism.

## Deployment procedure

For a future deployment, review and commit/push its source through the normal process:

1. In repository **Settings → Pages**, select **GitHub Actions** as the build source.
   Review the `github-pages` environment rules so the manual workflow may deploy.
2. In **Actions → Deploy Pages**, run the workflow from the reviewed default branch,
   setting `source_ref` to the full pushed distribution commit SHA and `version` to
   `0.2.1`. Equivalent command (replace the placeholder with the actual reviewed SHA):

   ```sh
   gh workflow run pages.yml --repo 0then0/overflowlens --ref main \
     -f source_ref=FULL_REVIEWED_COMMIT_SHA -f version=0.2.1
   ```

3. Wait for deployment success, inspect `/overflowlens/deployment.json`, then smoke-test
   both examples and a local import/export at the real HTTPS URL. A local build does
   not prove remote publication.
4. After that test, update the README and catalogue if needed. Set the
   repository's **About → Website** to `https://0then0.github.io/overflowlens/` (or
   `gh repo edit 0then0/overflowlens --homepage https://0then0.github.io/overflowlens/`).
   No existing repository metadata automation was found; this is a manual metadata change.

The downloadable archive and its local HTTP launch instructions remain available
regardless of Pages. Do not create a release merely for documentation or deployment changes.
