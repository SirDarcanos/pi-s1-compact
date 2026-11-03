# Staged npm publishing

The repository provides a manual GitHub Actions workflow at [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). It checks and stages an approved stable version from `main`; it does not make that version public. SirDarcanos reviews and approves each staged release on npm with two-factor authentication.

Merging a PR, pushing a tag, or creating a GitHub release does not trigger this workflow. Version bumps, workflow runs, npm approval, tags, and GitHub releases retain their separate approval requirements. Preparing this workflow does not authorize running it.

## One-time npm setup

In the `pi-s1-compact` package settings on npm, configure a GitHub Actions trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `SirDarcanos` |
| Repository | `pi-s1-compact` |
| Workflow filename | `publish.yml` (not the full path) |
| Environment name | Leave empty; this workflow does not use a GitHub environment |
| Allowed action | Staged publishing only; do not enable direct publishing or dist-tag management for this workflow |

No `NPM_TOKEN` or other long-lived publishing credential is needed. The staging job requests a short-lived identity through GitHub OIDC; the verification job has no OIDC permission. The repository URL in `package.json` must continue to match this repository.

SirDarcanos reported configuring npm during setup. The repository cannot prove that those npm settings match until an authorized staging run succeeds. npm documents an initial two-day validation window for newly created trusted-publisher connections; check the current npm settings before the first release and recreate an expired connection through a separately approved account change if necessary.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [staged publishing](https://docs.npmjs.com/staged-publishing/) documentation. OIDC from a public GitHub repository also generates public provenance linking the package to its source and workflow. Provenance establishes origin, not a guarantee of code safety.

## Stage an approved version

After this workflow is merged into `main`:

1. Obtain approval for the exact stable version and prepare its `package.json` and changelog changes through the normal branch-to-PR flow. The workflow never chooses or increments a version. Prerelease versions are intentionally rejected; they need a separately agreed tag policy.
2. In GitHub Actions, select **Stage npm release → Run workflow**, choose **main**, and enter the approved version exactly as it appears in `package.json`. Dispatching from another branch or a fork skips the publishing jobs. Do not dispatch merely to test authentication: a successful run creates an npm stage.
3. The verification job checks metadata, installs with `pnpm install --frozen-lockfile --ignore-scripts`, and runs `pnpm check` with live classifier tests disabled. It packs the distribution, rejects unexpected or missing files and release lifecycle hooks, compares packed bytes with the checked source, and uploads the verified tarball as the `npm-package` artifact for seven days. This does not run the separate Pi compatibility matrix or live model checks.
4. The staging job downloads and rechecks that same tarball. It uses pnpm to run the pinned npm CLI (`11.21.0`, which supports staged publishing) solely for `npm stage publish`, with public access, the `latest` distribution tag, lifecycle scripts disabled, and provenance. There is no direct-publish or approval command in CI. Both jobs use Node 24 and pinned action commits.
5. Review the workflow result, tarball checksum and artifact, and the npm stage identifier in the publishing log. A successful job means **staged**, not publicly released. Registry errors stop the run; there is no fallback to a token or direct publication.

An already staged version occupies the same version slot as a published version. If `0.1.0` or another approved version is already staged, review that existing stage on npm rather than restaging it. Do not automatically reject a stage, bump a version, or retry a failed or interrupted publication: inspect npm's actual state first. Replacing a stage needs separate approval.

## Approve and verify

1. On npm, open **Staged Packages**, select the exact package/version and stage identifier from the intended run, and review its contents and provenance. For an existing manually created stage, do not claim it has CI provenance.
2. SirDarcanos approves that specific release using npm's 2FA prompt. The workflow identity cannot perform this approval.
3. Read back the public version and distribution tag, for example with `pnpm view pi-s1-compact version dist-tags --registry=https://registry.npmjs.org/`. Check the approved version specifically if `latest` differs. Verify the public metadata includes `pi-package`; then check [pi.dev/packages](https://pi.dev/packages) separately. A stage or an npm placeholder does not establish installation readiness or gallery visibility.

Public registry availability, provenance, and pi.dev indexing remain unverified until those checks actually succeed. No tag or GitHub release is created by this process. Reverting the workflow does not remove an existing stage or undo a public npm release.
