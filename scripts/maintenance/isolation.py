"""Trusted host-side Docker boundary; never mount policy, evidence, keys or host homes."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import subprocess
import tarfile
import tempfile
import uuid

CONFIG = Path('/etc/orbit-maintenance/runner.json')
MAX_ARCHIVE = 64 * 1024 * 1024
IMAGE = re.compile(r'^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$')
SYNTHETIC = b'# Synthetic maintenance fixture; values come from the process.\n'


def clean_head(root, sha):
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if head != sha:
        raise ValueError('checkout HEAD differs from expected SHA')
    status = subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain=v1',
                                      '--untracked-files=no'], text=True)
    if status:
        raise ValueError('tracked checkout changes are forbidden before and after validation')


def config_errors(config):
    errors = []
    for key, expected in {'schema_version': 1, 'disposable_vm': True,
                          'workflow_admission': 'reviewed-policy-only'}.items():
        if type(config.get(key)) is not type(expected) or config.get(key) != expected:
            errors.append('invalid approved runner field: ' + key)
    if not IMAGE.fullmatch(config.get('candidate_image', '')):
        errors.append('approved candidate image must be digest-pinned')
    if not re.fullmatch(r'orbit-maintenance-[a-z0-9-]+', config.get('package_network', '')):
        errors.append('dedicated package network required')
    for field in ('network_policy_sha256', 'boundary_proof_sha256'):
        if not re.fullmatch(r'[0-9a-f]{64}', config.get(field, '')):
            errors.append('approved live proof digest required: ' + field)
    return errors


def approved_config(path=CONFIG):
    # A repository variable or candidate file cannot authorize a privileged runtime.
    if not str(path).startswith('/etc/orbit-maintenance/'):
        raise ValueError('runner approval must be installed under /etc/orbit-maintenance')
    for p in (path, path.parent):
        if p.is_symlink():
            raise ValueError('runner approval paths must not be symlinks')
        stat = p.stat()
        if stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ValueError('runner approval must be root-owned and not group/world writable')
    config = json.loads(path.read_text())
    errors = config_errors(config)
    if errors:
        raise ValueError('; '.join(errors))
    return config


def archive_manifest(data):
    if len(data) > MAX_ARCHIVE:
        raise ValueError('source/report archive exceeds the bounded size')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for entry in archive:
            name = str(PurePosixPath(entry.name))
            if name.startswith('/') or '..' in PurePosixPath(name).parts:
                raise ValueError('unsafe archive path')
            if entry.isdir():
                continue
            if not entry.isfile() or name in result:
                raise ValueError('only unique regular source/report files are accepted')
            result[name] = hashlib.sha256(archive.extractfile(entry).read()).hexdigest()
    return result


def committed_source(root, sha):
    clean_head(root, sha)
    listing = subprocess.check_output(['git', '-C', str(root), 'ls-tree', '-rlz', sha], timeout=30)
    entries = []
    total = 0
    for item in listing.split(b'\0'):
        if not item:
            continue
        metadata, raw_name = item.split(b'\t', 1)
        mode, kind, oid, size = metadata.decode().split()
        name = raw_name.decode()
        if PurePosixPath(name).name.startswith('.env'):
            continue  # Never read existing environment blobs, including .env.testing.
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('source symlinks/submodules need explicit support: ' + name)
        total += int(size)
        if total > MAX_ARCHIVE:
            raise ValueError('committed source exceeds the bounded size')
        entries.append((name, oid, int(size), int(mode[-3:], 8)))
    batch = subprocess.check_output(['git', '-C', str(root), 'cat-file', '--batch'],
                                    input=''.join(e[1] + '\n' for e in entries).encode(), timeout=30)
    stream, output = io.BytesIO(batch), io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:') as archive:
        for name, oid, size, mode in entries:
            if stream.readline().decode().strip() != f'{oid} blob {size}':
                raise ValueError('unexpected Git object response')
            contents = stream.read(size)
            if stream.read(1) != b'\n':
                raise ValueError('incomplete Git object response')
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.uid, entry.gid = size, mode, 10001, 10001
            archive.addfile(entry, io.BytesIO(contents))
        entry = tarfile.TarInfo('.env.testing')
        entry.size, entry.mode, entry.uid, entry.gid = len(SYNTHETIC), 0o600, 10001, 10001
        archive.addfile(entry, io.BytesIO(SYNTHETIC))
    data = output.getvalue()
    return data, archive_manifest(data)


def inspect_errors(info, volume, network, readonly=False):
    host, config = info.get('HostConfig', {}), info.get('Config', {})
    errors = []
    expected = {'Privileged': False, 'ReadonlyRootfs': True, 'NetworkMode': network,
                'PidMode': '', 'IpcMode': 'private', 'PidsLimit': 512,
                'UTSMode': '', 'UsernsMode': '', 'CgroupnsMode': 'private'}
    for key, value in expected.items():
        if host.get(key) != value:
            errors.append('unsafe container setting: ' + key)
    if set(host.get('CapDrop') or []) != {'ALL'} or host.get('CapAdd'):
        errors.append('all capabilities must be dropped')
    if set(host.get('SecurityOpt') or []) not in ({'no-new-privileges'}, {'no-new-privileges:true'}):
        errors.append('no-new-privileges is required')
    if host.get('Devices') or host.get('DeviceRequests') or host.get('PortBindings') or host.get('VolumesFrom'):
        errors.append('devices and published ports are forbidden')
    if host.get('Memory') != 4 * 1024**3 or host.get('NanoCpus') != 2_000_000_000:
        errors.append('bounded memory/CPU limits required')
    if config.get('User') != '10001:10001':
        errors.append('candidate must run as unprivileged UID/GID 10001')
    mounts = [m for m in info.get('Mounts', []) if m.get('Type') != 'tmpfs']
    if len(mounts) != 1 or any(m.get('Type') != 'volume' or m.get('Name') != volume or
                              m.get('Destination') != '/work' or m.get('RW') != (not readonly) for m in mounts):
        errors.append('only the disposable workspace volume may be mounted')
    if set(host.get('Tmpfs', {})) != {'/tmp'}:
        errors.append('only the private /tmp tmpfs is permitted')
    return errors


class DockerBoundary:
    def __init__(self, config, execute):
        self.config, self.execute = config, execute
        self.volume = 'orbit-maintenance-' + uuid.uuid4().hex
        self.ids = []
        self.docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
        self.host_env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}

    def call(self, args, data=None, timeout=60):
        def limit_output():
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ARCHIVE, MAX_ARCHIVE))
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            result = subprocess.run(self.docker + args, input=data, stdout=output, stderr=error,
                                    env=self.host_env, timeout=timeout, preexec_fn=limit_output)
            if result.returncode:
                raise ValueError('Docker boundary operation failed: ' + args[0])
            output.seek(0)
            return output.read(MAX_ARCHIVE)

    def preflight(self):
        image = json.loads(self.call(['image', 'inspect', self.config['candidate_image']]))[0]
        if self.config['candidate_image'] not in image.get('RepoDigests', []):
            raise ValueError('approved image digest is not present locally; no implicit pull')
        network = json.loads(self.call(['network', 'inspect', self.config['package_network']]))[0]
        if network.get('Driver') != 'bridge' or network.get('Labels', {}).get('orbit.maintenance.egress-policy') != self.config['network_policy_sha256']:
            raise ValueError('approved registry-only network policy is not installed')

    def __enter__(self):
        self.preflight()
        self.call(['volume', 'create', '--label', 'orbit.maintenance.disposable=true', self.volume])
        return self

    def __exit__(self, *unused):
        for cid in self.ids:
            self.call(['rm', '-f', cid])
        self.call(['volume', 'rm', self.volume])

    def create(self, command, env, network='none', readonly=False):
        mount = 'type=volume,src=' + self.volume + ',dst=/work' + (',readonly' if readonly else '')
        args = ['create', '--pull=never', '--read-only', '--user', '10001:10001',
                '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--ipc=private', '--cgroupns=private',
                '--network', network, '--pids-limit=512', '--memory=4g', '--cpus=2',
                '--mount', mount, '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
                '--workdir', '/work', '--entrypoint', '/usr/bin/env', self.config['candidate_image'],
                '-i', *[f'{k}={v}' for k, v in sorted(env.items())], *command]
        cid = self.call(args).decode().strip()
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            raise ValueError('unexpected Docker container identifier')
        self.ids.append(cid)
        info = json.loads(self.call(['inspect', cid]))[0]
        errors = inspect_errors(info, self.volume, network, readonly)
        if errors:
            raise ValueError('; '.join(errors))
        return cid

    def seed(self, data, env):
        cid = self.create(['/bin/true'], env)
        self.call(['cp', '-a', '-', cid + ':/work'], data=data)

    def run(self, command, env, log, timeout, network='none'):
        # The fixed shell only prepares private HOME. Candidate arguments are positional.
        cid = self.create(['/bin/sh', '-c', 'mkdir -p /tmp/home; exec "$@"', 'maintenance', *command], env, network)
        try:
            code = self.execute(self.docker + ['start', '-a', cid], Path('/tmp'),
                                self.host_env, log, timeout)
        finally:
            self.call(['stop', '--time', '1', cid])
        state = json.loads(self.call(['inspect', cid]))[0]['State']
        if state.get('Running') or state.get('OOMKilled'):
            return 1
        return code if code else state.get('ExitCode', 1)

    def source_manifest(self, expected, env):
        # A new trusted, read-only inspector runs after candidate processes have stopped.
        # It reads only host-selected source paths; its executable comes from the pinned image.
        names = sorted(expected)
        cid = self.create(['/usr/bin/tar', '-C', '/work', '-cf', '-', '--', *names], env, readonly=True)
        data = self.call(['start', '-a', cid])
        state = json.loads(self.call(['inspect', cid]))[0]['State']
        if state.get('ExitCode') != 0 or state.get('Running'):
            raise ValueError('read-only source inspector failed')
        return archive_manifest(data)

    def report(self, stage):
        # docker cp supplies raw tar data, never extract an untrusted archive onto the host.
        cid = self.ids[-1]
        data = self.call(['cp', cid + ':/work/.maintenance-' + stage + '.xml', '-'])
        archive_manifest(data)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            entries = [e for e in archive if e.isfile()]
            if len(entries) != 1:
                raise ValueError('expected one regular JUnit report')
            return archive.extractfile(entries[0]).read()
