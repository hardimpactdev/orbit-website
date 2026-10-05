# Orbit Website maintenance pilot

This is a PR-only prototype. Activation is off. No runner, App, secret, permission,
branch protection, merge or production setting is created by this branch.
The 01:17 UTC schedule scans only; an enabled main-branch dispatch with
`mode=candidate` may create draft candidates. Scheduled publication is a later decision.

## Dependency policy

Renovate 44.137.0 is pinned to OCI digest
`sha256:805dbf260d627b5dc53a59be9c26b7be2854977e47d3c94366e97b6cadc4a626`.
The pinned action accepts the complete `image:tag@sha256:digest` reference verbatim.
Composer and JavaScript/Bun compatible updates require a known release timestamp and
seven days of age. Security alerts bypass age only. Major/replacement/rollback/pin/
digest updates and broad lockfile maintenance stay disabled. There is one ordinary
and one security PR slot. All PRs remain drafts; automerge and deployment are disabled.
Controller package scripts/plugins and post-upgrade commands are disabled.

The dedicated App token explicitly requests Contents write, Pull requests write and
Vulnerability alerts read. Its key belongs only to the protected-main-only
`maintenance-controller` environment. Candidate jobs never receive it.

## Trusted verifier and candidate boundary

The workflow checks out policy from the PR base and candidate source at the exact head.
Only the trusted host verifier runs on the runner. It requires a clean tracked checkout
before and after execution, including a stable HEAD. Candidate source comes from Git
objects at that head; untracked files and every `.env*` blob are excluded without reading
their contents. An empty synthetic `.env.testing` is injected; test values are supplied
through a fixed process environment. No candidate code or package installation runs
directly on the host. There is no native execution fallback for the acceptance gate.

The verifier creates one disposable Docker workspace volume. Candidate containers have
read-only root filesystems, UID/GID 10001, all capabilities dropped, no-new-privileges,
private PID/IPC/cgroup namespaces, 512 processes, 4 GiB RAM and two CPUs. Their only
persistent mount is that job's workspace volume; `/tmp` is a private 512 MiB tmpfs.
No host bind mounts, policy, proof directory, key, Docker socket, home, devices or
published ports are accepted. Every container is inspected before it starts; unexpected
mounts or privilege settings fail closed. A namespace/access probe runs before installs.

Composer `--no-scripts --no-plugins` and Bun `--frozen-lockfile --ignore-scripts` run in
containers on the approved registry-only package network. Each application stage runs
in a fresh container with networking disabled. The existing browser runner's HTTP/SSR
servers communicate over loopback inside its container; port 13719 is not published.
Processes stop before evidence collection. Fresh read-only inspector containers read
only the host-selected source paths using the pinned image's tar executable. The host
compares source hashes before and after every stage; changed tests, scripts, manifests,
or other tracked source fail the run. Tar reports are parsed in memory, never extracted
onto host paths; symlinks, traversal, duplicates and oversized archives are rejected.

The host records Docker exit state, command results and JUnit data. Policy, receipts,
reports and gate decision are covered by a per-run HMAC seal whose private key remains
outside candidate/container/artifact storage. The independent gate rechecks the seal,
current policy hash, full head, context, contract, JUnit counts and report digests.
Changing policy or evidence after sealing fails. The key is not uploaded and is deleted
after evaluation; this is a same-run integrity boundary, not a portable public signature.
Artifacts retain logs and decisions; reproduce the run to obtain fresh acceptance.

Full checks remain PHP Unit/Feature with `--no-tia`, PHPStan, `vp check`, client and SSR
builds, and explicit browser execution. Warnings/risky PHP tests cause failure where
reported by PHPUnit. Missing/empty/skipped/failed reports cannot pass. The final
`maintenance-gate` job always evaluates PR prerequisites and rejects any missing,
skipped, cancelled or failed eligibility/verification job or mismatched proof output.
Make that final job required only through separately approved repository settings.

## Runner approval contract

Before any candidate execution, an administrator must provision a disposable one-job
VM and root-owned, non-symlink, non-group/world-writable
`/etc/orbit-maintenance/runner.json` and parent directory. Repository variables alone
cannot authorize Docker execution. This file is not created by the prototype.

Required configuration fields (placeholders below deliberately do not pass preflight):

```json
{
    "schema_version": 1,
    "disposable_vm": true,
    "workflow_admission": "reviewed-policy-only",
    "candidate_image": "APPROVED_REPOSITORY@sha256:APPROVED_DIGEST",
    "package_network": "orbit-maintenance-packages",
    "network_policy_sha256": "APPROVED_EGRESS_PROOF_DIGEST",
    "boundary_proof_sha256": "APPROVED_BOUNDARY_PROOF_DIGEST"
}
```

The image must already exist locally at the exact digest; no implicit pull occurs.
It needs PHP 8.5, Composer 2.9, repository-declared Bun 1.3.14, Node/VitePlus support,
matching Chromium at `/opt/playwright`, Python 3, `/usr/bin/env`, `/usr/bin/tar`,
`/bin/sh`, and an empty `/work` owned by UID/GID 10001. No image-declared extra volumes,
secrets, privileged helpers or host access. The host has Python 3 and `/usr/bin/docker`
using only `unix:///var/run/docker.sock`. The default Docker seccomp/LSM policy stays on.
The approved bridge network carries label `orbit.maintenance.egress-policy` matching
the configured digest. Firewall/egress enforcement and job admission are administrator
responsibilities, not established merely by that label or configuration declaration.

Before installing approval, independently prove namespace/mount isolation, rejection of
attempted policy/proof/key access and mutation, offline test egress, registry-only install
egress, process cleanup, volume disposal and correct toolchain. Admission must reject
unreviewed workflow code that could run arbitrary host steps, including PR workflow
edits; accept only the reviewed policy workflow version. Enforce this outside candidate
YAML through the runner service's admission control. The verifier does not claim that
its repository YAML or an approval variable can police a malicious replacement workflow.

Keep separate repository-allowlisted labels:
- `orbit-website-maintenance-controller`: reviewed main-only scan/reporting, isolated
  Docker daemon, no host socket mounted into Renovate, no production access.
- `orbit-website-maintenance-isolated`: trusted host verifier plus the boundary above;
  no production network/home/credentials or shared persistent caches.

Set `MAINTENANCE_RUNNER_APPROVED` and `MAINTENANCE_RUNNER_ISOLATED` only after proofs.
Install a repository-only maintenance App with metadata read, Contents write, Pull
requests write and Dependabot alerts read; no Workflows/Administration/Deployments/
Secrets permissions or bypass. Configure its ID variable and environment-only key
without pasting secrets into chat. Dependabot settings changes also need approval.
Keep `MAINTENANCE_PILOT_ENABLED` unset/false until separate activation approval.

## Remaining integration gates

No approved boundary/runner/App execution is claimed by offline fixtures. The existing
407-browser run failed at the earlier head. Focused base/candidate comparisons establish
nine stable baseline assertion mismatches and three intermittent cases; two intermittent
cases lack base reproduction. Browser repair is separate: do not weaken or redesign the
application/tests to manufacture green. Full browser proof at the final head remains due.

Initial trusted-base bootstrap remains an adoption gate: the first PR's base lacks this
policy. Authorized reviewers must resolve that bootstrap without trusting unreviewed
candidate verifier code. Orbit Tasks opens the PR through Anna -> OpsBot -> PlanBot;
ReviewBot owns exact-head review/merge, ProdBot any subsequent deployment.

Missing runners remain pending, not successful. The five-minute queue SLA is an operator
procedure, not a hosted-runner fallback. After approval, prove a real scan, draft candidate,
same-head final check and quarantine. The reporter uses no candidate checkout/artifact
execution, validates current PR identity and adds one idempotent receipt per head.
Grok transport remains receipt-only; no external messaging is implemented.

## Commands

```sh
python3 -m unittest discover -s scripts/maintenance -p 'test_*.py'
python3 scripts/maintenance/maintenance.py preflight
python3 scripts/maintenance/maintenance.py preflight --ci --runner
# The preceding command must fail on an unapproved host.
python3 scripts/maintenance/maintenance.py check --root CANDIDATE --sha FULL_HEAD_SHA --context RUN_ID/ATTEMPT --output FRESH_OUTPUT --key-file PRIVATE_HOST_KEY_PATH
python3 scripts/maintenance/maintenance.py gate --sha FULL_HEAD_SHA --context RUN_ID/ATTEMPT --output FRESH_OUTPUT --key-file PRIVATE_HOST_KEY_PATH
```

The check creates the new private key exclusively; its path must be outside the checkout
and output directory. Never archive or upload it. Local nonbrowser diagnostic runs may
use the safe environment/opaque-fixture helper against a clean isolated checkout, but
they create no accepted boundary seal and are not substitutes for the approved workflow.
The helper checks tracked cleanliness before replacement and after restoration, including
on exceptions. Commands are bounded, no test retries are automatic, and failures retain
the existing candidate as owner. At most two safe infrastructure retries and three repair
rounds; quarantine is removed only after a documented fix and fresh complete proof.
