#!/usr/bin/env python3
"""PR-only maintenance proofs. JSON output; no merge, deploy or notification API."""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

SHA = re.compile(r"^[0-9a-f]{40}$")
STAGES = ("php", "analysis", "frontend", "build", "browser")
TEST_STAGES = ("php", "browser")


def load(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def contract_check(contract, renovate):
    errors = []
    expected = {"mode": "pr-only", "automerge": False, "deploy": False,
                "ordinary_age_days": 7, "security_bypasses_age_only": True,
                "production_tests": False, "test_retries": 0}
    for key, value in expected.items():
        if contract.get(key) != value:
            errors.append("contract must preserve " + key)
    if contract.get("required_stages") != list(STAGES):
        errors.append("all five verification stages are mandatory")
    if contract.get("test_stages") != list(TEST_STAGES):
        errors.append("PHP and browser execution reports are mandatory")
    if contract.get("allowed_update_types") != ["patch", "minor"]:
        errors.append("broad or major updates are outside the pilot")
    for key, value in {"automerge": False, "platformAutomerge": False,
                       "minimumReleaseAge": "7 days", "minimumReleaseAgeBehaviour": "timestamp-required",
                       "internalChecksFilter": "strict", "recreateWhen": "never",
                       "rebaseWhen": "never", "stopUpdatingLabel": "maintenance-quarantined",
                       "ignoreScripts": True, "ignorePlugins": True}.items():
        if renovate.get(key) != value:
            errors.append("Renovate must preserve " + key)
    security = renovate.get("vulnerabilityAlerts", {})
    if security.get("minimumReleaseAge") != "0 days" or security.get("automerge") is not False:
        errors.append("security may bypass age only")
    if not any(r.get("enabled") is False and "major" in r.get("matchUpdateTypes", [])
               for r in renovate.get("packageRules", [])):
        errors.append("major updates must remain disabled")
    return errors


def eligibility(update, now):
    """Independent policy fixture/receipt check, not a dependency version solver."""
    if update.get("update_type") not in ("patch", "minor"):
        return False, "outside-compatible-update-policy"
    if update.get("quarantined"):
        return False, "quarantined"
    if update.get("security"):
        # A flag alone is not proof: require a resolved advisory identifying this fix.
        if not update.get("advisory_id") or update.get("fix_verified") is not True:
            return False, "unverified-security-fix"
        return True, "security-age-exception-only"
    try:
        released = dt.datetime.fromisoformat(update["released_at"].replace("Z", "+00:00"))
        if released.tzinfo is None:
            raise ValueError("timezone required")
        age = now - released
    except (KeyError, TypeError, ValueError):
        return False, "release-timestamp-required"
    return (age >= dt.timedelta(days=7), "ordinary-seven-day-policy")


def junit_counts(path):
    root = ET.parse(path).getroot()
    cases = list(root.iter("testcase"))
    # Count actual cases, not a parent testsuites summary that may double-count children.
    return {"tests": len(cases),
            "assertions": sum(int(c.get("assertions", "0")) for c in cases),
            "failures": sum(len(c.findall("failure")) for c in cases),
            "errors": sum(len(c.findall("error")) for c in cases),
            "skipped": sum(len(c.findall("skipped")) for c in cases)}


def validate(receipts, sha, context, contract_hash):
    errors = []
    if not SHA.fullmatch(sha):
        errors.append("expected SHA must be a full nonempty commit hash")
    if set(receipts) != set(STAGES):
        errors.append("missing or unexpected stage receipts")
    for stage in STAGES:
        r = receipts.get(stage, {})
        for key, value in {"schema_version": 1, "stage": stage, "sha": sha,
                           "context": context, "contract_hash": contract_hash,
                           "executed": True, "status": "passed", "exit_code": 0}.items():
            if r.get(key) != value or type(r.get(key)) is not type(value):
                errors.append(stage + ": invalid " + key)
        if not isinstance(r.get("command"), list) or not r.get("command"):
            errors.append(stage + ": missing command")
        if stage in TEST_STAGES:
            report = r.get("junit", {})
            if type(report.get("tests")) is not int or report.get("tests", 0) < 1:
                errors.append(stage + ": zero or missing tests")
            if type(report.get("assertions")) is not int or report.get("assertions", 0) < 1:
                errors.append(stage + ": zero or missing assertions")
            for key in ("failures", "errors", "skipped"):
                if type(report.get(key)) is not int or report.get(key) != 0:
                    errors.append(stage + ": nonzero or missing " + key)
            if not re.fullmatch(r"[0-9a-f]{64}", r.get("junit_sha256", "")):
                errors.append(stage + ": missing report digest")
    return errors


def failure(sha, stage, context, exit_code):
    # Stable across retries of the same head/stage; excludes logs, time and secrets.
    fingerprint = digest({"repository": "nckrtl/orbit-website", "sha": sha, "stage": stage})
    return {"schema_version": 1, "repository": "nckrtl/orbit-website", "sha": sha,
            "stage": stage, "context": context, "exit_code": exit_code,
            "fingerprint": fingerprint, "quarantined": True, "owner": "OpsBot",
            "external_notification_sent": False, "next_gate": "paired base/candidate reproduction",
            "max_correction_rounds": 3}


def safe_environment(root, home):
    # Do not inherit CI tokens, cloud keys or application environment from the host.
    # Candidate code can still read its own VM filesystem: CI therefore requires a clean VM.
    return {"PATH": str(root / 'node_modules/.bin') + ':' + os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home), "TMPDIR": str(home), "CI": "true", "NO_COLOR": "1",
            "APP_ENV": "testing", "APP_URL": "http://127.0.0.1",
            "APP_KEY": "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "APP_DEBUG": "false", "DB_CONNECTION": "sqlite", "DB_DATABASE": ":memory:",
            "DB_URL": "", "CACHE_STORE": "array", "SESSION_DRIVER": "array",
            "QUEUE_CONNECTION": "sync", "MAIL_MAILER": "array",
            "BROADCAST_CONNECTION": "null", "INERTIA_SSR_ENABLED": "false",
            "NIGHTWATCH_ENABLED": "false", "TELESCOPE_ENABLED": "false",
            "VP_GIT_HOOKS": "0", "COMPOSER_NO_INTERACTION": "1",
            "PLAYWRIGHT_BROWSERS_PATH": os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/playwright")}


@contextmanager
def withheld_testing_fixture(root):
    """Replace the opaque fixture with an empty synthetic file, then restore it unread."""
    fixture = root / '.env.testing'
    if fixture.is_symlink():
        raise ValueError('testing fixture must not be a symlink')
    # A rename must stay on the checkout's filesystem; /tmp may be another mount.
    with tempfile.TemporaryDirectory(prefix='.orbit-maintenance-opaque-fixture-', dir=root.parent) as temp:
        backup = Path(temp) / 'fixture'
        existed = fixture.exists()
        if existed:
            fixture.rename(backup)
        try:
            # Laravel selects this file from APP_ENV=testing. Leaving it absent makes
            # dotenv fall back to the intentionally absent .env and warn on every test.
            # All configuration values still come from safe_environment, never this file.
            with fixture.open('x') as synthetic:
                synthetic.write('# Synthetic maintenance fixture; configuration is supplied by the process.\n')
            fixture.chmod(0o600)
            yield
        finally:
            # Only a file created by this isolated test run can now occupy this path.
            if fixture.exists():
                fixture.unlink()
            if existed:
                backup.rename(fixture)


def execute(command, root, env, log, timeout):
    with open(log, "w") as output:
        process = subprocess.Popen(command, cwd=root, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 124
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise


def run_checks(args, contract):
    root, out = Path(args.root).resolve(), Path(args.output).resolve()
    if (root / '.env').exists():
        raise ValueError("isolated checkout must not contain .env; do not reuse live app configuration")
    if (root / 'bootstrap/cache/config.php').exists():
        raise ValueError("cached application configuration is forbidden in isolated validation")
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if head != args.sha:
        raise ValueError("checkout HEAD differs from expected SHA")
    if out.exists() and any(out.iterdir()):
        raise ValueError("use a fresh output directory; stale receipts must never pass")
    out.mkdir(parents=True, exist_ok=True)
    commands = {
        'php': ['php', 'vendor/bin/pest', '--no-tia', '--fail-on-warning', '--fail-on-risky', '--testsuite=Unit,Feature', '--log-junit', str(out/'php.xml')],
        'analysis': ['composer', 'analyse'],
        'frontend': ['vp', 'check'],
        'build': ['bun', 'run', 'build'],
        'browser': ['php', 'scripts/run-browser-tests.php', '--no-tia', '--fail-on-warning', '--fail-on-risky', '--log-junit', str(out/'browser.xml')],
    }
    receipts = {}
    with withheld_testing_fixture(root), tempfile.TemporaryDirectory(prefix='orbit-maintenance-') as home:
        env = safe_environment(root, Path(home))
        for stage, command in commands.items():
            start = time.monotonic()
            try:
                code = execute(command, root, env, out/(stage+'.log'), contract['maximum_command_seconds'])
            except OSError as error:
                code = 127
                (out/(stage+'.log')).write_text(str(error))
            receipt = {"schema_version": 1, "sha": args.sha, "context": args.context,
                       "contract_hash": digest(contract), "stage": stage, "command": command,
                       "executed": True, "status": "passed" if code == 0 else "failed",
                       "exit_code": code, "duration_seconds": round(time.monotonic()-start, 3)}
            if stage in TEST_STAGES:
                try:
                    path = out/(stage+'.xml')
                    receipt['junit'] = junit_counts(path)
                    receipt['junit_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                except (OSError, ValueError, ET.ParseError):
                    receipt['status'] = 'failed'
            receipts[stage] = receipt
            write(out/(stage+'.json'), receipt)
            if code != 0:
                write(out/'failure.json', failure(args.sha, stage, args.context, code))
                break
    errors = validate(receipts, args.sha, args.context, digest(contract))
    if errors and not (out/'failure.json').exists():
        write(out/'failure.json', failure(args.sha, 'evidence', args.context, 1))
    write(out/'gate.json', {"passed": not errors, "sha": args.sha, "errors": errors})
    return {"passed": not errors, "sha": args.sha, "errors": errors, "output": str(out)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', default='.maintenance/contract.json')
    commands = parser.add_subparsers(dest='action', required=True)
    preflight = commands.add_parser('preflight', help='validate policy and explicit runner approval; no writes')
    preflight.add_argument('--renovate', default='renovate.json')
    preflight.add_argument('--ci', action='store_true')
    check = commands.add_parser('check', help='run isolated full checks; writes receipts only; never deploys')
    for name in ('root', 'sha', 'context', 'output'):
        check.add_argument('--'+name, required=True)
    check.add_argument('--dry-run', action='store_true')
    gate = commands.add_parser('gate', help='validate all current execution receipts')
    for name in ('sha', 'context', 'output'):
        gate.add_argument('--'+name, required=True)
    policy = commands.add_parser('policy', help='verify a normalized proposed update against the age/security policy')
    policy.add_argument('--update', required=True)
    args = parser.parse_args()
    try:
        contract = load(args.contract)
        if args.action == 'preflight':
            errors = contract_check(contract, load(args.renovate))
            if args.ci and (os.environ.get('MAINTENANCE_RUNNER_APPROVED') != 'true' or
                            os.environ.get('MAINTENANCE_RUNNER_ISOLATED') != 'true'):
                errors.append('approved isolated runner required; see docs/maintenance-pilot.md')
            result = {'passed': not errors, 'errors': errors, 'mode': 'pr-only'}
        elif args.action == 'policy':
            allowed, reason = eligibility(load(args.update), dt.datetime.now(dt.timezone.utc))
            result = {'passed': allowed, 'reason': reason, 'tests_and_review_still_required': True}
        elif args.action == 'check':
            result = {'passed': True, 'dry_run': True, 'stages': list(STAGES), 'side_effects': 'isolated test files and receipts only'} if args.dry_run else run_checks(args, contract)
        else:
            out = Path(args.output)
            receipts = {stage: load(out/(stage+'.json')) for stage in STAGES if (out/(stage+'.json')).is_file()}
            errors = validate(receipts, args.sha, args.context, digest(contract))
            # Rehash and reparse actual reports instead of trusting receipt summaries.
            for stage in TEST_STAGES:
                try:
                    path = out/(stage+'.xml')
                    if hashlib.sha256(path.read_bytes()).hexdigest() != receipts.get(stage, {}).get('junit_sha256'):
                        errors.append(stage+': report digest mismatch')
                    if junit_counts(path) != receipts.get(stage, {}).get('junit'):
                        errors.append(stage+': report counts mismatch')
                except (OSError, ValueError, ET.ParseError):
                    errors.append(stage+': missing or malformed JUnit')
            result = {'passed': not errors, 'sha': args.sha, 'errors': errors}
        print(json.dumps(result, sort_keys=True))
        return 0 if result['passed'] else 1
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'passed': False, 'error': str(error), 'next_action': 'fix the named precondition; do not bypass the gate'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
