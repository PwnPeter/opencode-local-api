import importlib.util
import io
import os
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
            captured = []

            def download(command, **kwargs):
                archive = Path(command[command.index('--output') + 1])
                archive.write_bytes(b'fixture')
                captured.append(archive.parent)

            def unpack(archive, binary, digest):
                binary.write_bytes(b'fixture')

            def extract(command, env, label, timeout):
                Path(env['RELAY_ENVELOPE_OUTPUT']).write_text('{}')

            with patch.object(installer, 'release', return_value=('test', 'https://example.invalid', 'digest')), \
                    patch.object(installer.subprocess, 'run', side_effect=download), \
                    patch.object(installer, 'unpack_binary', side_effect=unpack), \
                    patch.object(installer, 'checked_run', side_effect=extract), \
                    patch.object(installer, 'verify', side_effect=ValueError('incompatible update')):
                with self.assertRaisesRegex(ValueError, 'incompatible'):
                    installer.regenerate(config, {'OPENCODE_API_KEY': 'test-key'}, '/usr/bin/node', True)
            self.assertEqual((config / 'envelope.json').read_text(), 'working protocol')
            self.assertTrue(captured)
            self.assertFalse(captured[0].exists())

    def test_extraction_installs_only_the_expected_regular_binary(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name, payload in [('opencode', b'official binary fixture'), ('../outside', b'bad')]:
                    item = tarfile.TarInfo(name)
                    item.size = len(payload)
                    tar.addfile(item, io.BytesIO(payload))
            binary = Path(tmp) / 'runtime' / 'opencode'
            binary.parent.mkdir()
            installer.unpack_binary(archive, binary, hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(binary.read_bytes(), b'official binary fixture')
            self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o755)
            self.assertFalse((Path(tmp) / 'outside').exists())


if __name__ == '__main__':
    unittest.main()
