# Native macOS source evidence

The `test` matrix retains Linux and `macos-latest`, and `build` still needs the entire
`test` matrix. All Linux checks temporarily use ephemeral GitHub-hosted Ubuntu 24.04
because the legacy self-hosted queue is unavailable. Fork PR checks remain hosted;
the protected Janus gate must be commissioned before any Linux cutover.
This change does not authorize a Buildkite build or replace either test leg.

On pushes to `main` and same-repository PRs into `main`, the macOS leg captures
`source.json` immediately after checkout and Bun setup. Capture and upload both
finish before `bun install`, type checking, linting, formatting or tests. A failed
capture/upload stops the leg. Fork PRs skip both evidence steps and continue their
normal checks; a future Janus consumer must independently reject forks.

Capture runs outside the checkout with a minimal environment, no Bun environment
file loading, no auto-install, and an explicit empty Bun config. It imports only
Node built-ins. It reads the real Git HEAD, tree and raw commit parents, checks the
origin and clean checkout, and compares them with the expected GitHub identity.
Raw parents work even with checkout's depth-one clone. Git replacement objects,
inherited Git overrides, and user/system Git configuration are ignored.

## Artifact schema

One UTF-8 JSON object plus a newline; at most 4,096 bytes. No extra fields, secrets,
credentials, event dump, local paths or arbitrary environment values belong in it.
The event input is a regular non-symlink file limited to 2 MiB. Failures log only a
fixed message. This is the complete schema (`null` is required where indicated):

| Field | Type and meaning |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `repository`, `repositoryId` | Literal `aditzel/project-settings-sync`; positive safe decimal GitHub ID as a string |
| `event` | `push` or `pull_request` |
| `workflowPath`, `workflowSha` | `.github/workflows/ci.yml`; tested commit SHA containing that workflow |
| `job`, `matrixOs` | `test`, `macos-latest` |
| `runId`, `runAttempt` | Positive safe decimal strings; attempt is at most 999999 |
| `ref` | `refs/heads/main` or `refs/pull/<number>/merge` |
| `pullRequest` | Positive integer at most 2147483647 for a PR; `null` for a push |
| `sourceSha` | Push `after` or PR head, verified against actual checkout facts |
| `baseSha` | PR base commit; `null` for a push |
| `testedSha`, `treeSha` | Actual checkout HEAD and tree; nonzero lowercase 40-hex Git object IDs |
| `parents` | Actual ordered parent IDs, at most 16; exactly `[baseSha, sourceSha]` for a PR |

Push evidence requires `sourceSha == testedSha == GITHUB_SHA`. PR evidence requires
an open, same-repository PR into `main`, the matching PR merge ref and GitHub SHA,
and a real two-parent merge with the specified order. The workflow SHA must equal
the tested SHA. Unsupported events, missing fields and mismatches fail closed.
GitHub documents that `pull_request` normally tests its merge ref, while the PR
head SHA identifies the source branch. [Event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)

The pinned official `actions/upload-artifact` v4.6.2 creates
`native-macos-<runId>-<runAttempt>`, containing only `source.json`, with two-day
retention, `overwrite: false`, and missing-file failure. The local output is also
created exclusively. Upload-artifact v4 artifacts are immutable after creation;
the capture is uploaded before project code can change the local file.
[Upload behavior](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)

## Contract for the future trusted controller

The artifact is **source evidence, not a successful-test receipt or a signature**.
The workflow and capture script are repository-controlled. A consumer must verify
that their exact source blobs match a reviewed, protected producer definition;
a PR editing that producer cannot authorize itself by supplying matching JSON.
Early upload limits later project commands, but is not isolation from a malicious
producer or runner. Artifact names, metadata, or successful capture alone never
admit work to Janus.

1. Independently resolve the intended repository ID, source SHA, event and PR/base
   identity using the GitHub API. Reject forks (including same-name/different-ID
   repositories), wrong branches, closed/stale PRs and unsupported events. Resolve
   the tested commit and tree through the Git data API; verify ordered parents.
2. Resolve the exact workflow ID/path and run ID from that source. Read both the
   current run and `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}`.
   Require the requested attempt to be the current one, with matching identity;
   recheck before admission. GitHub keeps a run ID while incrementing the attempt
   on reruns. Never use the newest artifact from an arbitrary run or a prior attempt.
   [Run API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)
   [Run identity variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
3. Paginate the exact attempt's jobs endpoint,
   `.../runs/{run_id}/attempts/{attempt}/jobs`, rather than the mixed/latest jobs
   view. Require exactly one expected native test job (`test (macos-latest)` in the
   current workflow), its run identity, GitHub-hosted macOS labels, completed
   `success`, and successful checkout, setup, capture, upload, install, typecheck,
   lint, format and test steps in the reviewed order. A skipped, cancelled, timed
   out, incomplete or failed native job is not evidence of passing tests. Partial
   reruns that do not execute the macOS leg again have no eligible artifact/job
   pair for the new attempt: rerun all jobs. [Attempt jobs API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
4. Paginate that run's artifacts. Require exactly one unexpired artifact with the
   full expected name, matching workflow-run/repository/head-repository IDs and
   source identity. The artifact API provides run metadata, not a producer job ID
   or run-attempt field: bind the attempt through the exact name, JSON and successful
   upload step. Match the returned artifact ID and archive digest to the authenticated
   upload-step log, before the next install step; verify the downloaded archive digest.
   API artifact creation timestamps can lag step completion and cannot prove ordering.
   Require the successful upload step to precede installation instead.
   Reject duplicate names, replacement uploads, expired/deleted artifacts and any
   ambiguity. [Artifacts API](https://docs.github.com/en/rest/actions/artifacts)
5. Download only from the authenticated artifact endpoint; cap archive size and
   decompression (e.g. 64 KiB archive, 4 KiB extracted). Require one regular file
   named `source.json`: no traversal, symlinks, duplicate entries or extra files.
   Strictly validate the schema and compare every field to the independently
   resolved identity. Do not execute artifact content or use it to select a script.
6. Only after **both** native macOS tests and Janus Linux tests pass for this exact
   tested/source identity may the Linux build start. The future protected gate
   must implement this dependency before removing `build.needs: test`; an aggregate
   posted after an early build would not preserve the existing ordering.

The consumer, authenticated artifact transport, same-source Linux gate and live
rerun/expiry rejection are future commissioning work. This producer does not add
credentials, dispatch builds, weaken permissions or publish releases.

## Local validation

`bun test scripts/ci/native-source.test.ts` exercises real loose Git objects and
shallow parent behavior, push and PR identity, invalid/fork/dirty sources, bounded
input and sanitized failures. Native macOS also exercises the complete capture
process, exclusive artifact creation and separate attempt paths. Run the original
`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun test` and
`bun run build` gates before delivery.
