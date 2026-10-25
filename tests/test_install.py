import importlib.util
import base64
import io
import os
import runpy
import shutil
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install.py')
installer = None
if spec and spec.origin and Path(spec.origin).exists():
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(installer, 'portable installer must exist')

    def test_direct_install_rejects_node_before_the_sqlite_runtime_requirement(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp}), \
                patch.object(sys, 'argv', ['install.py', 'prepare']), \
                patch.object(installer.shutil, 'which', return_value='/usr/bin/fixture'), \
                patch.object(installer.subprocess, 'check_output', return_value='v22.18.0'), \
                patch.object(installer, 'credentials', side_effect=AssertionError('unsupported runtime accepted')):
            with self.assertRaisesRegex(ValueError, '22.19'):
                installer.main()

    def test_prepare_interruption_exits_with_resume_instructions(self):
        with patch.object(sys, 'argv', ['install.py', 'prepare']), \
                patch.object(subprocess, 'check_output', side_effect=KeyboardInterrupt):
            with self.assertRaises(BaseException) as raised:
                runpy.run_path(str(ROOT / 'scripts/install.py'), run_name='__main__')
        self.assertIsInstance(raised.exception, SystemExit)
        self.assertIn('resume', str(raised.exception))

    def test_first_install_keeps_private_credentials_after_interruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'opencode-local-api'
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'OPENCODE_API_KEY': 'resume-key-fixture'}), \
                    patch.object(sys, 'argv', ['install.py']), \
                    patch.object(installer, 'regenerate', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    installer.main()
            saved = installer.read_environment(config / 'environment')
            self.assertEqual(saved.get('OPENCODE_API_KEY'), 'resume-key-fixture')
            self.assertEqual(stat.S_IMODE((config / 'environment').stat().st_mode), 0o600)
            with patch.dict(os.environ, {}, clear=True), patch.object(installer.getpass, 'getpass', side_effect=AssertionError('key requested again')):
                resumed = installer.credentials(config)
            self.assertEqual(resumed, saved)

    def test_setup_reuses_an_installed_harness_without_npm(self):
        setup_path = ROOT / 'scripts/setup.py'
        self.assertTrue(setup_path.is_file(), 'guided setup is missing')
        setup_spec = importlib.util.spec_from_file_location('guided_setup', setup_path)
        setup = importlib.util.module_from_spec(setup_spec)
        with patch.dict(sys.modules, {'install': installer}):
            setup_spec.loader.exec_module(setup)
        with tempfile.TemporaryDirectory() as tmp:
            prefix = Path(tmp)
            binary = prefix / 'bin/dsh'
            binary.parent.mkdir()
            binary.write_text('#!/bin/sh\nprintf "0.2.1-rc.2\\n"\n')
            binary.chmod(0o755)
            with patch.dict(os.environ, {'PATH': ''}):
                self.assertEqual(setup.ensure_harness(prefix), binary)

    def test_container_prepare_reuses_protocol_without_systemd_and_keeps_local_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'opencode-local-api'
            config.mkdir()
            (config / 'envelope.json').write_text('verified protocol fixture')
            (config / 'native-runtime').write_bytes(b'verified runtime fixture')
            node = shutil.which('node')
            curl = shutil.which('curl')
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': tmp, 'OPENCODE_API_KEY': 'container-key-fixture'}), \
                    patch.object(sys, 'argv', ['install.py', 'prepare']), \
                    patch.object(installer.shutil, 'which', side_effect=lambda name: {'node': node, 'curl': curl}.get(name)):
                installer.main()
                saved = installer.read_environment(config / 'environment')
                installer.main()
            self.assertEqual(installer.read_environment(config / 'environment'), saved)
            self.assertEqual(saved['OPENCODE_API_KEY'], 'container-key-fixture')
            self.assertNotEqual(saved['OPENCODE_LOCAL_API_KEY'], saved['OPENCODE_API_KEY'])
            self.assertEqual((config / 'envelope.json').read_text(), 'verified protocol fixture')
            self.assertEqual(stat.S_IMODE((config / 'harness.env').stat().st_mode), 0o600)
            self.assertFalse((Path(tmp) / 'systemd').exists())

    def test_configuration_is_portable_private_and_preserves_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'another user %n $project'
            project.mkdir()
            (project / 'config').mkdir()
            name = 'config/opencode-local-api.service'
            (project / name).write_text((ROOT / name).read_text())
            config = Path(tmp) / 'config'
            units = Path(tmp) / 'units'
            with patch.dict(os.environ, {'OPENCODE_API_KEY': 'test-upstream-key'}):
                values = installer.credentials(config)
                self.assertTrue(installer.configure(project, config, units, Path('/usr/bin/node'), values))
                original = (config / 'environment').read_text()
                self.assertFalse(installer.configure(project, config, units, Path('/usr/bin/node'), installer.credentials(config)))
            self.assertEqual((config / 'environment').read_text(), original)
            values = installer.read_environment(config / 'environment')
            self.assertEqual(values['OPENCODE_API_KEY'], 'test-upstream-key')
            self.assertGreaterEqual(len(values['OPENCODE_LOCAL_API_KEY']), 32)
            self.assertNotEqual(values['OPENCODE_LOCAL_API_KEY'], values['OPENCODE_API_KEY'])
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((config / 'environment').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((config / 'harness.env').stat().st_mode), 0o600)
            self.assertFalse((config / 'opencode').exists())
            unit = (units / 'opencode-local-api.service').read_text()
            self.assertIn('%%n $$project', unit)
            self.assertNotIn('/home/peterpan', unit)
            self.assertNotIn('test-upstream-key', unit)

    def test_three_keys_survive_reconfiguration_and_stay_out_of_harness_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)
            with patch.dict(os.environ, {
                'OPENCODE_API_KEY': 'primary-fixture',
                'OPENCODE_API_KEY_BACKUP': 'backup-fixture',
                'OPENCODE_API_KEYS': ' third-fixture, , third-fixture ',
            }, clear=True):
                installer.save_credentials(config, installer.credentials(config))
            original = installer.read_environment(config / 'environment')
            with patch.dict(os.environ, {}, clear=True):
                values = installer.credentials(config)
                installer.save_credentials(config, values)
            self.assertEqual(values, original)
            self.assertEqual(values['OPENCODE_API_KEY'], 'primary-fixture')
            self.assertEqual(values.get('OPENCODE_API_KEY_BACKUP'), 'backup-fixture')
            self.assertEqual(values.get('OPENCODE_API_KEYS'), 'third-fixture')
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((config / 'environment').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((config / 'harness.env').stat().st_mode), 0o600)
            self.assertEqual(installer.read_environment(config / 'harness.env'), {
                'OPENCODE_LOCAL_API_KEY': values['OPENCODE_LOCAL_API_KEY'],
            })

    def test_key_list_can_supply_the_initial_primary_without_a_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {'OPENCODE_API_KEYS': ' first-fixture, second-fixture, first-fixture, third-fixture '}, clear=True), \
                    patch.object(installer.getpass, 'getpass', side_effect=AssertionError('unexpected key prompt')):
                values = installer.credentials(Path(tmp))
            self.assertEqual(values['OPENCODE_API_KEY'], 'first-fixture')
            self.assertEqual(values['OPENCODE_API_KEYS'], 'first-fixture,second-fixture,third-fixture')

    def test_proxy_pool_configuration_survives_reinstallation_without_leaking_to_harness(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)
            pool = config / 'proxies.json'
            pool.write_text('[]')
            with patch.dict(os.environ, {'OPENCODE_API_KEY': 'key-fixture'}, clear=True):
                values = installer.credentials(config)
                installer.save_credentials(config, values)
            self.assertEqual(values.get('RELAY_PROXIES_FILE'), str(pool))
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(installer.credentials(config), values)
            self.assertNotIn('RELAY_PROXIES_FILE', installer.read_environment(config / 'harness.env'))

    def test_preferred_interface_configuration_survives_reinstallation(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)
            preferred = {'RELAY_PREFERRED_INTERFACE': 'wlp3s0', 'RELAY_PREFERRED_KEY_FINGERPRINT': 'a' * 64, 'RELAY_PREFERRED_REQUIRED': '1',
                         'RELAY_PREFERRED_CONNECTION_UUID': '2806a8ec-4cc7-45c7-afdc-bb71468efd13',
                         'RELAY_PINNED_ROUTE_FILE': str(config / 'pinned-route.json')}
            with patch.dict(os.environ, {'OPENCODE_API_KEY': 'fixture', **preferred}, clear=True):
                values = installer.credentials(config)
                installer.save_credentials(config, values)
            with patch.dict(os.environ, {}, clear=True):
                restored = installer.credentials(config)
            for name, value in preferred.items():
                self.assertEqual(restored.get(name), value)
            harness = installer.read_environment(config / 'harness.env')
            self.assertFalse(any(name in harness for name in preferred))

    def test_checksum_failure_does_not_replace_existing_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive.tar.gz'
            archive.write_bytes(b'invalid download')
            binary = Path(tmp) / 'opencode'
            binary.write_bytes(b'original binary')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                installer.unpack_binary(archive, binary, '0' * 64)
            self.assertEqual(binary.read_bytes(), b'original binary')

    def test_probe_diagnostics_report_status_without_replaying_sensitive_logs(self):
        result = subprocess.CompletedProcess([], 1, stdout='Check: text\n', stderr='Error: HTTP 403; private-key-fixture\n')
        with patch.object(installer.subprocess, 'run', return_value=result):
            with self.assertRaises(ValueError) as raised:
                installer.checked_run(['node', 'verify.mjs'], {}, 'Verification', 10)
        self.assertIn('HTTP 403', str(raised.exception))
        self.assertIn('during text', str(raised.exception))
        self.assertNotIn('private-key-fixture', str(raised.exception))

    def test_failed_regeneration_preserves_the_working_protocol_and_removes_temporary_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)
            (config / 'envelope.json').write_text('working protocol')
            (config / 'native-runtime').write_bytes(b'working runtime')
            captured = []

            def download(command, **kwargs):
                archive = Path(command[command.index('--output') + 1])
                archive.write_bytes(b'fixture')
                captured.append(archive.parent)

            def unpack(archive, binary, digest):
                binary.write_bytes(b'fixture')

            def extract(command, env, label, timeout, **kwargs):
                self.assertIn('--standalone', command)
                self.assertNotIn('--dir', command)
                self.assertTrue(Path(kwargs['cwd']).is_dir())
                self.assertEqual(env['OPENCODE_API_KEY'], 'public')
                Path(env['RELAY_ENVELOPE_OUTPUT']).write_text('{}')

            with patch.object(installer, 'release', return_value=('test', 'https://example.invalid', 'digest')), \
                    patch.object(installer.subprocess, 'run', side_effect=download), \
                    patch.object(installer, 'unpack_binary', side_effect=unpack), \
                    patch.object(installer, 'checked_run', side_effect=extract), \
                    patch.object(installer, 'verify', side_effect=ValueError('incompatible update')):
                with self.assertRaisesRegex(ValueError, 'incompatible'):
                    installer.regenerate(config, {'OPENCODE_API_KEY': 'test-key'}, '/usr/bin/node', True)
            self.assertEqual((config / 'envelope.json').read_text(), 'working protocol')
            self.assertEqual((config / 'native-runtime').read_bytes(), b'working runtime')
            self.assertTrue(captured)
            self.assertFalse(captured[0].exists())

    def test_successful_regeneration_keeps_the_verified_http_runtime_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)
            def download(command, **kwargs):
                Path(command[command.index('--output') + 1]).write_bytes(b'archive')
            def unpack(archive, binary, digest):
                binary.write_bytes(b'verified native runtime')
            def extract(command, env, label, timeout, **kwargs):
                Path(env['RELAY_ENVELOPE_OUTPUT']).write_text('{"version":"2.1.4"}')
            def verify(envelope, values, node):
                self.assertEqual(Path(values['RELAY_NATIVE_RUNTIME_FILE']).read_bytes(), b'verified native runtime')
            with patch.object(installer, 'release', return_value=('2.1.4', 'https://example.invalid', 'digest')), \
                    patch.object(installer.subprocess, 'run', side_effect=download), \
                    patch.object(installer, 'unpack_binary', side_effect=unpack), \
                    patch.object(installer, 'checked_run', side_effect=extract), \
                    patch.object(installer, 'verify', side_effect=verify):
                installer.regenerate(config, {'OPENCODE_API_KEY': 'key-fixture'}, '/usr/bin/node', False)
            self.assertEqual((config / 'native-runtime').read_bytes(), b'verified native runtime')
            self.assertEqual(stat.S_IMODE((config / 'native-runtime').stat().st_mode), 0o700)

    def test_failed_envelope_publication_restores_the_previous_runtime(self):
        for existing_runtime in [False, True]:
            with self.subTest(existing_runtime=existing_runtime), tempfile.TemporaryDirectory() as tmp:
                config = Path(tmp)
                (config / 'envelope.json').write_text('old protocol')
                if existing_runtime:
                    (config / 'native-runtime').write_bytes(b'old runtime')
                def download(command, **kwargs):
                    Path(command[command.index('--output') + 1]).write_bytes(b'archive')
                def unpack(archive, binary, digest):
                    binary.write_bytes(b'new runtime')
                def extract(command, env, label, timeout, **kwargs):
                    Path(env['RELAY_ENVELOPE_OUTPUT']).write_text('{"version":"2.1.4"}')
                with patch.object(installer, 'release', return_value=('2.1.4', 'https://example.invalid', 'digest')), \
                        patch.object(installer.subprocess, 'run', side_effect=download), \
                        patch.object(installer, 'unpack_binary', side_effect=unpack), \
                        patch.object(installer, 'checked_run', side_effect=extract), \
                        patch.object(installer, 'verify'), \
                        patch.object(installer, 'private_write', side_effect=OSError('Publication failed')):
                    with self.assertRaisesRegex(OSError, 'Publication failed'):
                        installer.regenerate(config, {'OPENCODE_API_KEY': 'key-fixture'}, '/usr/bin/node', False)
                self.assertEqual((config / 'envelope.json').read_text(), 'old protocol')
                if existing_runtime:
                    self.assertEqual((config / 'native-runtime').read_bytes(), b'old runtime')
                else:
                    self.assertFalse((config / 'native-runtime').exists())
                self.assertFalse(list(config.glob('native-runtime.previous-*')))

    def test_extraction_installs_only_the_expected_regular_binary(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name, payload in [('package/bin/opencode', b'official binary fixture'), ('../outside', b'bad')]:
                    item = tarfile.TarInfo(name)
                    item.size = len(payload)
                    tar.addfile(item, io.BytesIO(payload))
            binary = Path(tmp) / 'runtime' / 'opencode'
            binary.parent.mkdir()
            digest = 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
            installer.unpack_binary(archive, binary, digest)
            self.assertEqual(binary.read_bytes(), b'official binary fixture')
            self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o755)
            self.assertFalse((Path(tmp) / 'outside').exists())

    def test_release_uses_the_current_cli_distribution_and_verified_npm_integrity(self):
        import json
        metadata = {'version': '2.1.4', 'dist': {
            'tarball': 'https://registry.npmjs.org/@opencode/cli-linux-x64-baseline/-/cli-linux-x64-baseline-2.1.4.tgz',
            'integrity': 'sha512-' + base64.b64encode(b'x' * 64).decode(),
        }}
        with patch.object(installer.platform, 'machine', return_value='x86_64'), \
                patch.object(installer.subprocess, 'check_output', return_value=json.dumps(metadata)) as get:
            version, url, digest = installer.release(True)
        self.assertEqual(version, '2.1.4')
        self.assertEqual(url, metadata['dist']['tarball'])
        self.assertEqual(digest, metadata['dist']['integrity'])
        self.assertIn('https://registry.npmjs.org/@opencode%2Fcli-linux-x64-baseline/latest', get.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
