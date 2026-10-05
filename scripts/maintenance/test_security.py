"""Offline adversarial fixtures for the trusted host/container boundary; no Docker writes."""
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import maintenance as m
import isolation as i

ROOT = Path(__file__).resolve().parents[2]
SHA = 'a' * 40


class SecurityTest(unittest.TestCase):
    def test_workflow_explicit_alert_permission_and_immutable_image(self):
        workflow=(ROOT/'.github/workflows/maintenance.yml').read_text()
        self.assertIn('permission-vulnerability-alerts: read',workflow)
        self.assertIn('renovate-image: ghcr.io/renovatebot/renovate:44.137.0@sha256:805dbf260d627b5dc53a59be9c26b7be2854977e47d3c94366e97b6cadc4a626',workflow)
        self.assertIn('needs: [eligibility, verify]',workflow)
        self.assertIn("if: always() && github.event_name == 'pull_request'",workflow)
        self.assertNotIn('working-directory: candidate',workflow)

    def test_every_failed_missing_skipped_cancelled_job_blocks(self):
        good={'eligibility':{'result':'success'},'verify':{'result':'success','outputs':
             {'proof_passed':'true','proof_sha':SHA,'proof_context':'run/1'}}}
        self.assertEqual([],m.final_results(good,SHA,'run/1'))
        for job in ('eligibility','verify'):
            for result in ('skipped','cancelled','failure',None):
                needs=copy.deepcopy(good);needs[job]['result']=result
                self.assertTrue(m.final_results(needs,SHA,'run/1'))
            needs=copy.deepcopy(good);del needs[job]
            self.assertTrue(m.final_results(needs,SHA,'run/1'))
        for key in ('proof_passed','proof_sha','proof_context'):
            needs=copy.deepcopy(good);needs['verify']['outputs'][key]='wrong'
            self.assertTrue(m.final_results(needs,SHA,'run/1'))

    def test_changed_receipt_report_gate_policy_and_extra_proof_block(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);out=root/'proof';out.mkdir();key=root/'key'
            key.write_bytes(b'offline-fixture-key');key.chmod(0o600)
            m.write(out/'boundary.json',{'executor':'docker-no-host-mounts','passed':True})
            for name in ('php.json','php.xml','gate.json'):(out/name).write_text('fixture')
            m.seal_evidence(out,key,SHA,'run/1')
            m.verify_seal(out,key,SHA,'run/1')
            for name in ('php.json','php.xml','gate.json'):
                original=(out/name).read_bytes();(out/name).write_text('candidate-forgery')
                with self.assertRaises(ValueError):m.verify_seal(out,key,SHA,'run/1')
                (out/name).write_bytes(original)
            with patch.object(m,'policy_hash',return_value='changed-policy'):
                with self.assertRaises(ValueError):m.verify_seal(out,key,SHA,'run/1')
            (out/'extra.json').write_text('{}')
            with self.assertRaises(ValueError):m.verify_seal(out,key,SHA,'run/1')

    def test_invalid_boundary_or_world_readable_key_cannot_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);out=root/'proof';out.mkdir();key=root/'key'
            key.write_bytes(b'offline-fixture-key');key.chmod(0o600)
            m.write(out/'boundary.json',{'executor':'native','passed':True})
            m.seal_evidence(out,key,SHA,'run/1')
            with self.assertRaises(ValueError):m.verify_seal(out,key,SHA,'run/1')
            key.chmod(0o644)
            with self.assertRaises(ValueError):m.verify_seal(out,key,SHA,'run/1')

    def git_fixture(self, root):
        for command in (['git','init','-q'],['git','add','.'],['git','-c','user.name=Fixture',
                        '-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-qm','fixture']):
            subprocess.run(command,cwd=root,check=True,capture_output=True,timeout=5)
        return subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()

    def test_dirty_staged_deleted_and_wrong_head_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'source.txt';p.write_text('original');sha=self.git_fixture(root)
            i.clean_head(root,sha)
            p.write_text('modified')
            with self.assertRaises(ValueError):i.clean_head(root,sha)
            subprocess.run(['git','add','.'],cwd=root,check=True,capture_output=True)
            with self.assertRaises(ValueError):i.clean_head(root,sha)
            p.unlink()
            with self.assertRaises(ValueError):i.clean_head(root,sha)
            with self.assertRaises(ValueError):i.clean_head(root,SHA)

    def test_source_export_omits_env_blobs_and_injects_synthetic_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'source.txt').write_text('source')
            (root/'.env.testing').write_text('UNIT_TEST_SENTINEL_DO_NOT_EXPORT')
            sha=self.git_fixture(root);data,manifest=i.committed_source(root,sha)
            self.assertNotIn(b'UNIT_TEST_SENTINEL_DO_NOT_EXPORT',data)
            self.assertEqual(hashlib.sha256(i.SYNTHETIC).hexdigest(),manifest['.env.testing'])
            self.assertIn('source.txt',manifest)

    def test_fixture_restore_then_provenance_check_detects_test_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'source.txt').write_text('source')
            fixture=root/'.env.testing';fixture.write_text('original unit-test fixture')
            self.git_fixture(root)
            with self.assertRaises(ValueError):
                with m.withheld_testing_fixture(root):(root/'source.txt').write_text('modified')
            self.assertEqual('original unit-test fixture',fixture.read_text())

    def safe_inspect(self):
        return {'Config':{'User':'10001:10001'},'HostConfig':{
            'Privileged':False,'ReadonlyRootfs':True,'NetworkMode':'none','PidMode':'',
            'IpcMode':'private','UTSMode':'','UsernsMode':'','CgroupnsMode':'private',
            'PidsLimit':512,'CapDrop':['ALL'],'CapAdd':None,'SecurityOpt':['no-new-privileges:true'],
            'Memory':4*1024**3,'NanoCpus':2_000_000_000,'Tmpfs':{'/tmp':'private'}},
            'Mounts':[{'Type':'volume','Name':'fixture-volume','Destination':'/work','RW':True}]}

    def test_host_policy_proof_socket_mounts_and_privileges_rejected(self):
        good=self.safe_inspect();self.assertEqual([],i.inspect_errors(good,'fixture-volume','none'))
        for target in ('/policy','/proof','/var/run/docker.sock','/home/runner'):
            info=copy.deepcopy(good);info['Mounts'].append({'Type':'bind','Destination':target,'RW':True})
            self.assertTrue(i.inspect_errors(info,'fixture-volume','none'))
        for key,value in [('Privileged',True),('ReadonlyRootfs',False),('NetworkMode','host'),
                          ('PidMode','host'),('IpcMode','host'),('CapAdd',['SYS_ADMIN']),
                          ('SecurityOpt',['no-new-privileges:true','seccomp=unconfined'])]:
            info=copy.deepcopy(good);info['HostConfig'][key]=value
            self.assertTrue(i.inspect_errors(info,'fixture-volume','none'))

    def test_readonly_inspector_cannot_accept_writable_volume(self):
        info=self.safe_inspect()
        self.assertTrue(i.inspect_errors(info,'fixture-volume','none',readonly=True))
        info['Mounts'][0]['RW']=False
        self.assertEqual([],i.inspect_errors(info,'fixture-volume','none',readonly=True))

    def test_unapproved_runner_and_mutable_image_fail_closed(self):
        with self.assertRaises(ValueError):i.approved_config(Path('/tmp/candidate-approval.json'))
        good={'schema_version':1,'disposable_vm':True,'workflow_admission':'reviewed-policy-only',
              'candidate_image':'registry.example/runtime@sha256:'+'a'*64,
              'package_network':'orbit-maintenance-packages','network_policy_sha256':'b'*64,
              'boundary_proof_sha256':'c'*64}
        self.assertEqual([],i.config_errors(good))
        for key,value in [('candidate_image','runtime:latest'),('disposable_vm',False),
                          ('workflow_admission','all-pr-workflows'),('boundary_proof_sha256','')]:
            self.assertTrue(i.config_errors({**good,key:value}))

    def test_report_symlink_or_traversal_is_rejected_without_extraction(self):
        for name,kind in [('../proof.json',tarfile.REGTYPE),('report.xml',tarfile.SYMTYPE)]:
            data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w:') as archive:
                entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname='/host/policy'
                archive.addfile(entry,io.BytesIO(b''))
            with self.assertRaises(ValueError):i.archive_manifest(data.getvalue())

    def test_whole_host_verifier_seals_success_and_rejects_source_tampering(self):
        # A fake Docker adapter tests orchestration without pretending the live OS boundary passed.
        class FixtureBoundary:
            tamper=False
            def __init__(self,config,execute):self.after_stage=False
            def __enter__(self):return self
            def __exit__(self,*unused):pass
            def seed(self,data,env):self.manifest=i.archive_manifest(data)
            def run(self,command,env,log,timeout,network='none'):
                Path(log).write_text('offline fixture; no application execution')
                if command[:2]==['php','vendor/bin/pest']:self.after_stage=True
                return 0
            def source_manifest(self,expected,env):
                return {**expected,'forged':'0'*64} if self.tamper and self.after_stage else expected
            def report(self,stage):return b'<testsuite><testcase assertions="2"/></testsuite>'
        for tamper in (False,True):
            with self.subTest(tamper=tamper),tempfile.TemporaryDirectory() as temp:
                root=Path(temp)/'candidate';root.mkdir();(root/'source.txt').write_text('source')
                sha=self.git_fixture(root)
                args=SimpleNamespace(root=str(root),sha=sha,context='fixture/1',
                     output=str(Path(temp)/'proof'),key_file=str(Path(temp)/'key'))
                config={'candidate_image':'example/runtime@sha256:'+'a'*64,
                        'boundary_proof_sha256':'b'*64,'package_network':'orbit-maintenance-packages'}
                FixtureBoundary.tamper=tamper
                with patch.object(i,'approved_config',return_value=config),patch.object(i,'DockerBoundary',FixtureBoundary):
                    result=m.run_checks(args,m.load(ROOT/'.maintenance/contract.json'))
                self.assertEqual(not tamper,result['passed'])
                if tamper:
                    with self.assertRaises(ValueError):m.verify_seal(args.output,args.key_file,sha,'fixture/1')
                else:m.verify_seal(args.output,args.key_file,sha,'fixture/1')

    def test_missing_runner_approval_blocks_before_execution_or_receipts(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'candidate';root.mkdir();(root/'source.txt').write_text('source')
            sha=self.git_fixture(root)
            args=SimpleNamespace(root=str(root),sha=sha,context='fixture/1',
                 output=str(Path(temp)/'proof'),key_file=str(Path(temp)/'key'))
            with patch.object(i,'approved_config',side_effect=FileNotFoundError('unapproved runner')),patch.object(i,'DockerBoundary') as boundary:
                with self.assertRaises(FileNotFoundError):m.run_checks(args,m.load(ROOT/'.maintenance/contract.json'))
                boundary.assert_not_called()
            self.assertFalse(Path(args.output).exists())


if __name__ == '__main__':unittest.main()
