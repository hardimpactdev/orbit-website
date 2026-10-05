# Orbit Website maintenance pilot

This branch is a PR-only prototype. It does not enable a default-branch schedule,
register a runner, add secrets, change branch protection, merge or deploy anything.
The schedule configuration is 01:17 UTC; scheduled runs scan only. An enabled
`workflow_dispatch` with `mode=candidate` permits Renovate draft PRs. Adoption of
scheduled candidate creation is a later explicit rollout decision.

## What runs

Pinned Renovate 44.137.0 owns dependency discovery and lockfile resolution for
Composer and JavaScript/Bun. Ordinary compatible releases must be seven days old
with known timestamps. Upstream security alerts may bypass age only; major,
replacement and broad lockfile-maintenance updates stay disabled. There is one
ordinary PR slot and one security slot. All candidates remain drafts and cannot
automerge. Package scripts/plugins and post-upgrade commands are disabled in the
credentialed controller. The controller never runs application tests.

The separate candidate VM has no write token or application secrets. It checks
out the exact PR head and uses the verification program from the trusted base.
It runs full Unit/Feature tests with `--no-tia`, existing PHPStan analysis,
`vp check`, client and SSR builds, and the existing browser runner explicitly.
This preserves `composer check` components and closes the live Orbit task-check
gap: the current Orbit check omits browser tests. No Orbit project setting changes.

The gate requires actual JUnit test cases and assertions, zero skips/failures/errors,
current full SHA, run context, contract digest and report digest. Missing tools,
missing browser binaries, absent reports, skipped jobs or stale evidence fail.
Feature tests disable SSR; their success is not SSR rendering proof. The existing
browser runner builds and starts its own SSR process, checks its health, and renders
the isolated candidate with SSR errors enabled. It uses fixed port 13719, so local
validation must first prove that port is free; never stop another instance's SSR.
Production process/page checks remain outside this PR-only prototype.

## Runner and permission request before enablement

Only nckrtl/orbit currently has verified Sabre runner registrations. Request two
repository-allowlisted, disposable one-job VM capabilities for nckrtl/orbit-website:

- Controller label `orbit-website-maintenance-controller`: trusted protected-base
  configuration only; isolated Docker daemon inside its VM; no host Docker socket
  mounted into Renovate. Network to GitHub and required registries only.
- Candidate label `orbit-website-maintenance-isolated`: clean filesystem and test
  data, no production network or mounted home/secrets, no persistent shared caches.
  PHP 8.5, Composer 2.9, Bun compatible with the committed packageManager, VitePlus
  and a matching Playwright Chromium installation at `/opt/playwright` are needed.
  Pin and record the approved image digest during provisioning.

Set repository variables `MAINTENANCE_RUNNER_APPROVED=true` and
`MAINTENANCE_RUNNER_ISOLATED=true` only after a disposable-runner proof. Missing
variables make preflight exit nonzero. No matching runner leaves the job pending,
never successful; cancel a queue that exceeds the operator's five-minute queue SLA.
There is no hosted/shared runner fallback and no runner registration in this branch.

Install a dedicated maintenance GitHub App on this repository only. It needs
Contents write and Pull requests write to create draft candidates, plus verified
read access to security advisories/Dependabot alerts for the security lane.
Supply `MAINTENANCE_APP_ID` and `MAINTENANCE_APP_PRIVATE_KEY` through GitHub's
protected configuration. Do not reuse ReviewBot's personal credential.
Set `MAINTENANCE_PILOT_ENABLED=true` only after the reviewed policy is on main and
the runner/App proofs pass. Do not run candidate code in `pull_request_target`.

The initial infrastructure PR cannot validate itself with a policy script that is
not yet on its base branch. Its full local proofs accompany the prototype handoff;
CI intentionally fails closed until the reviewed policy exists on the trusted base.
Do not change the workflow to trust unreviewed candidate policy to bypass that gate.

## Failures quarantine and bounded work

The verifier makes one test attempt, bounds each command and kills its process
group on timeout. It writes a stable SHA/stage failure fingerprint and a quarantined
receipt with an OpsBot handoff. There are no real Slack/Grok notification calls.
The reporting workflow labels only the current failing maintenance PR and adds
one idempotent comment per failing head. Renovate stops updating that label and
does not recreate closed PRs or automatically rebase a failed candidate.

Keep the existing PR as the repair owner. OpsBot routes paired base/candidate
reproduction to BugBot; a healthy base with a failing update is a compatibility
regression, not a fabricated main bug. PlanBot may create one repair group when
reproduced. Allow at most two safe infrastructure retries and three correction
rounds; deterministic test failures are not retried blindly. Remove quarantine
only after a documented fix/new relevant version and review; rerun every gate.
Transport integration and automated Grok delivery remain disabled until an
authenticated endpoint, deduplication acknowledgment and permissions are approved.

No production credentials or targets are included. Later deployment must have one
owner, full artifact identity, real page rendering checks and a separately proved
safe rollback contract. Switching code cannot undo database migrations or external
effects. ReviewBot and ProdBot's current role contract remains unchanged.

## Local proof commands

The Python suite tests the control-plane wrapper, not Laravel behavior. Existing
application tests remain Pest tests. Run from the repository root:

```sh
python3 scripts/maintenance/test_maintenance.py
python3 scripts/maintenance/maintenance.py preflight
python3 scripts/maintenance/maintenance.py preflight --ci
# The last command MUST fail without approved-runner variables.
python3 scripts/maintenance/maintenance.py check --root . --sha FULL_HEAD_SHA \
  --context local-validation --output /tmp/unique-new-maintenance-receipts
python3 scripts/maintenance/maintenance.py gate --sha FULL_HEAD_SHA \
  --context local-validation --output /tmp/unique-new-maintenance-receipts
```

Use a clean development checkout with no `.env`, `.env.testing` or cached application
config. Never run this against a live instance. Install locked dependencies without
lifecycle scripts in a clean environment, then perform explicit package discovery.
`check --dry-run` describes stages without executing them. Local receipts are
clearly identified as local and do not substitute for approved Actions execution.

The normalized `policy --update file.json` command provides a separate review/fixture
check for age and verified security exceptions; Renovate performs actual version
selection. A normalized file is not trusted advisory evidence by itself. Neither
command grants permission to merge. Preserve upstream advisory links in the PR.

References: [Renovate release age](https://docs.renovatebot.com/configuration-options/#minimumreleaseage),
[security alerts](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts),
[self-hosted script controls](https://docs.renovatebot.com/self-hosted-configuration/#allowscripts),
[GitHub self-hosted runner security](https://docs.github.com/en/actions/reference/security/secure-use).
