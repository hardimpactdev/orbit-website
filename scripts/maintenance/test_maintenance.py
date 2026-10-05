"""Offline tests for the maintenance control plane; no application or network writes."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import hashlib

SPEC = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('maintenance.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
ROOT = Path(__file__).resolve().parents[2]
HEAD = 'a' * 40
CONTEXT = 'fixture/1'


class MaintenanceProofTest(unittest.TestCase):
    def setUp(self):
        self.contract = m.load(ROOT / '.maintenance/contract.json')
        self.renovate = m.load(ROOT / 'renovate.json')
        self.receipts = {stage: {'schema_version': 1, 'stage': stage, 'sha': HEAD,
            'context': CONTEXT, 'contract_hash': m.digest(self.contract), 'executed': True,
            'status': 'passed', 'exit_code': 0, 'command': ['fixture', stage],
            'junit': {'tests': 4, 'assertions': 9, 'failures': 0, 'errors': 0, 'skipped': 0},
            'junit_sha256': 'b'*64} for stage in m.STAGES}

    def errors(self, receipts=None, sha=HEAD):
        return m.validate(receipts or self.receipts, sha, CONTEXT, m.digest(self.contract))

    def test_complete_execution_passes(self):
        self.assertEqual([], self.errors())

    def test_every_missing_stage_blocks(self):
        for stage in m.STAGES:
            with self.subTest(stage=stage):
                receipts = copy.deepcopy(self.receipts)
                del receipts[stage]
                self.assertTrue(self.errors(receipts))

    def test_skipped_neutral_not_executed_nonzero_and_wrong_head_block(self):
        for patch in ({'status': 'skipped'}, {'status': 'neutral'}, {'executed': False},
                      {'exit_code': 1}, {'sha': 'c'*40}, {'context': 'previous/1'},
                      {'contract_hash': 'old-policy'}):
            with self.subTest(patch=patch):
                receipts = copy.deepcopy(self.receipts)
                receipts['browser'].update(patch)
                self.assertTrue(self.errors(receipts))

    def test_empty_and_abbreviated_expected_sha_block(self):
        self.assertTrue(self.errors(sha=''))
        self.assertTrue(self.errors(sha=HEAD[:7]))

    def test_zero_missing_skipped_failed_test_evidence_blocks(self):
        for change in ({'tests': 0}, {'assertions': 0}, {'skipped': 1}, {'errors': 1}, {'failures': 1}):
            with self.subTest(change=change):
                receipts = copy.deepcopy(self.receipts)
                receipts['php']['junit'].update(change)
                self.assertTrue(self.errors(receipts))
        del self.receipts['browser']['junit']
        self.assertTrue(self.errors())

    def test_missing_report_digest_blocks(self):
        del self.receipts['browser']['junit_sha256']
        self.assertTrue(self.errors())

    def test_boolean_counts_and_integer_executed_flag_block(self):
        self.receipts['php']['junit']['tests'] = True
        self.assertTrue(self.errors())
        self.receipts['php']['junit']['tests'] = 4
        self.receipts['php']['executed'] = 1
        self.assertTrue(self.errors())

    def test_gate_cli_rechecks_real_reports_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)
            for stage in m.TEST_STAGES:
                path=out/(stage+'.xml')
                path.write_text('<testsuite><testcase assertions="2"/></testsuite>')
                self.receipts[stage]['junit']=m.junit_counts(path)
                self.receipts[stage]['junit_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
            for stage,receipt in self.receipts.items():
                m.write(out/(stage+'.json'),receipt)
            command=[sys.executable,str(ROOT/'scripts/maintenance/maintenance.py'),'--contract',str(ROOT/'.maintenance/contract.json'),
                     'gate','--sha',HEAD,'--context',CONTEXT,'--output',str(out)]
            passed=subprocess.run(command,capture_output=True,text=True,timeout=10)
            self.assertEqual(0,passed.returncode,passed.stdout)
            (out/'browser.xml').write_text('<testsuite/>')
            failed=subprocess.run(command,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(0,failed.returncode)
            self.assertIn('mismatch',failed.stdout)
            (out/'php.xml').unlink()
            missing=subprocess.run(command,capture_output=True,text=True,timeout=10)
            self.assertIn('missing or malformed JUnit',missing.stdout)

    def test_command_timeout_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            code=m.execute([sys.executable,'-c','import time; time.sleep(30)'],ROOT,
                           m.safe_environment(ROOT,Path(tmp)),Path(tmp)/'timeout.log',0.05)
            self.assertEqual(124,code)

    def test_testing_fixture_is_withheld_and_restored_even_on_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            fixture=root/'.env.testing'
            fixture.write_text('synthetic fixture for this unit test')
            with self.assertRaises(RuntimeError):
                with m.withheld_testing_fixture(root):
                    self.assertFalse(fixture.exists())
                    raise RuntimeError('simulated test failure')
            self.assertEqual('synthetic fixture for this unit test',fixture.read_text())

    def test_junit_counts_cases_without_double_counting_parent_summaries(self):
        xml = '<testsuites tests="2"><testsuite tests="2"><testcase assertions="3"/><testcase assertions="1"><skipped/></testcase></testsuite></testsuites>'
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'junit.xml'
            p.write_text(xml)
            self.assertEqual({'tests':2,'assertions':4,'skipped':1,'failures':0,'errors':0},m.junit_counts(p))

    def test_policy_config_preserves_guards(self):
        self.assertEqual([],m.contract_check(self.contract,self.renovate))
        for key, value in [('automerge',True),('minimumReleaseAge','0 days'),('recreateWhen','always'),('ignoreScripts',False)]:
            config = copy.deepcopy(self.renovate)
            config[key] = value
            self.assertTrue(m.contract_check(self.contract,config))

    def test_seven_day_boundary(self):
        now = dt.datetime(2026,10,5,12,tzinfo=dt.timezone.utc)
        for age, allowed in [(dt.timedelta(days=7),True),(dt.timedelta(days=7,seconds=-1),False),(dt.timedelta(seconds=-1),False)]:
            update = {'update_type':'patch','released_at':(now-age).isoformat()}
            self.assertEqual(allowed,m.eligibility(update,now)[0])

    def test_unknown_timestamp_fails_closed(self):
        self.assertFalse(m.eligibility({'update_type':'minor'},dt.datetime.now(dt.timezone.utc))[0])

    def test_security_bypasses_age_only(self):
        update={'update_type':'patch','security':True,'advisory_id':'GHSA-fixture','fix_verified':True}
        self.assertTrue(m.eligibility(update,dt.datetime.now(dt.timezone.utc))[0])
        self.receipts['browser']['exit_code']=1
        self.assertTrue(self.errors())
        for patch in ({'update_type':'major'},{'quarantined':True},{'fix_verified':False},{'advisory_id':''}):
            self.assertFalse(m.eligibility({**update,**patch},dt.datetime.now(dt.timezone.utc))[0])

    def test_failure_idempotency_and_no_notification(self):
        first=m.failure(HEAD,'browser','run/1',1)
        second=m.failure(HEAD,'browser','run/2',124)
        self.assertEqual(first['fingerprint'],second['fingerprint'])
        self.assertNotEqual(first['fingerprint'],m.failure('b'*40,'browser','run/3',1)['fingerprint'])
        self.assertTrue(first['quarantined'])
        self.assertFalse(first['external_notification_sent'])

    def test_clean_environment_does_not_inherit_tokens(self):
        from unittest.mock import patch
        with patch.dict(m.os.environ,{'GITHUB_TOKEN':'fixture-secret','AWS_SECRET_ACCESS_KEY':'fixture-secret','DATABASE_URL':'production'}):
            env=m.safe_environment(ROOT,Path('/tmp/fixture'))
            self.assertNotIn('GITHUB_TOKEN',env)
            self.assertNotIn('AWS_SECRET_ACCESS_KEY',env)
            self.assertNotIn('DATABASE_URL',env)
            self.assertEqual(':memory:',env['DB_DATABASE'])


if __name__ == '__main__':
    unittest.main()
