# Flow end-to-end rollout

This plan follows the live route used by this repository: MCP client → local forwarding owner → authenticated remote device session → VPS queue → browser extension → Flow tab → Chrome download → MCP-visible file. TobyFlow is a reference for Flow-specific driver isolation, preflight gates, positive submit evidence, operation checkpoints, normalized errors, and retrying only when an operation is known to be safe. Its page selectors and internal API paths are not copied as dependencies.

## Phase 0 — Freeze the contract and establish evidence

- Record MCP tool arguments, backend methods, extension capabilities, output fields, and the expected owner of each filesystem path.
- Keep local unit tests, local HTTP/MCP E2E, extension transport E2E, and real Flow acceptance as separate evidence levels.
- Gate: every implemented tool has a known route and a test boundary; no test reports a real Flow pass when it used a fake backend.

## Phase 1 — Session and connection recovery

- Verify pairing, device identity, bearer-token isolation, session replacement, stale-session rejection, websocket and HTTP-poll reconnect, and the local owner’s forwarding route.
- Verify that status reports the same device, remote backend, extension version/capabilities, job list, and usable output location.
- Gate: MCP status and a harmless read-only tool work after reconnect and reject the wrong device token.

## Phase 2 — Input files and generation submission

- Stage local MCP files into the authenticated per-device VPS upload area before forwarding calls that use first/last frames, image references, character images, media upload, re-angle inputs, or explicit assembly tracks.
- Verify model capability checks, settings, references, frames, and local/asset/character input distinctions before queueing.
- Verify submit confirmation using editor clearing, disabled/accepted controls, or a new Flow tile; never replay a possibly submitted paid job.
- Gate: image and video request payloads arrive intact at the intended device queue; invalid combinations fail before submission.

## Phase 3 — Job lifecycle and classified recovery

- Exercise queue persistence, wait/task IDs, progress, cancel-before-start, safe retry, restart during queued/running work, quota, rate limit, expired session, generation failure, captcha, and download failure.
- Keep unknown submission outcomes blocked from automatic retry. Keep captcha and account verification as a manual checkpoint.
- Gate: each terminal state is represented consistently in MCP and Studio; only confirmed safe failures can be retried.

## Phase 4 — Flow library operations

- Exercise projects/open-project, asset and character listing, reference attachment, upload, download, rename/trash, character create/edit, edit, continue, agent batches, and re-angle.
- Check that every destructive or paid operation has the intended confirmation and that partial batch failures preserve completed items.
- Gate: each operation is covered by a local fake-extension E2E before live acceptance.

## Phase 5 — Output and local workflows

- Transfer browser-owned download bytes back to the VPS output directory, then materialize authenticated remote outputs onto the MCP host with size/checksum/path checks.
- Exercise narration, voice listing, assembly with returned or explicit tracks, output listing, and local discard semantics.
- Gate: returned file paths exist on the MCP host and can be consumed by a subsequent MCP tool.

## Phase 6 — Live acceptance

- Run status and library reads, then one user-authorized image and one video after Flow is ready.
- Verify the job lifecycle, resulting bytes, local output paths, asset listing, and one reuse path such as download or assembly.
- Gate: record real Flow evidence separately from all automated/fake tests. Pause for user verification if Flow presents CAPTCHA or account review; do not automate or bypass it.

## Current evidence and open gates

- Phase 0: in progress; baseline transport and selector regression tests exist.
- Phase 1: remote `flow_status` succeeded through the authenticated VPS session; broader reconnect/session cases remain to be exercised.
- Phase 2: capability registry packaging and selector-regex transport were fixed; the latest image reached Flow but stopped at Google’s unusual-activity verification without charging credits.
- Phase 3: error categories and unknown-outcome retry guards exist; restart/captcha lifecycle E2E remains incomplete.
- Phase 4: individual operations have unit coverage, but no complete fake-extension MCP matrix exists yet.
- Phase 5: remote input staging and browser-to-VPS output transfer are required for files to work across the VPS boundary.
- Phase 6: not passed; a successful generated file has not yet been observed in this session.
