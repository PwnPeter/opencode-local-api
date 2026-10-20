import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('installer', ROOT / 'install.py')
installer = None
if spec and spec.origin and Path(spec.origin).exists():
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(installer, 'portable installer must exist')

    def test_configuration_is_portable_private_and_preserves_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'another user %n $project'
            project.mkdir()
            for name in ['opencode-local-api.service']:
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
