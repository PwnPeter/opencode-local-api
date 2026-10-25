import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class RetestTests(unittest.TestCase):
    def test_offline_check_validates_routes_without_touching_production_or_starting_tests(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'retest.mjs'
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            pin = directory / 'production-pin.json'
            pin.write_text('{"preserve":true}')
            plan_file = directory / 'plan.json'
            route = {'name': 'second-proxy', 'key_fingerprint': hashlib.sha256(b'second-fixture').hexdigest(),
                     'proxy': {'url': 'socks5h://192.0.2.2:1080', 'ip': '198.51.100.2'}}
            plan = {'routes': [route], 'output_directory': str(directory / 'reports')}
            environment = {k: v for k, v in os.environ.items() if k in ['PATH', 'LANG']}
            environment.update({'HOME': temporary, 'XDG_CONFIG_HOME': str(directory / 'config'),
                                'OPENCODE_API_KEY': 'first-fixture', 'OPENCODE_API_KEYS': 'second-fixture',
                                'RELAY_PINNED_ROUTE_FILE': str(pin)})
            node = shutil.which('node-22') or shutil.which('node')

            def check(*options):
                plan_file.write_text(json.dumps(plan))
                return subprocess.run([node, str(script), str(plan_file), '--check', *options], env=environment,
                                      text=True, capture_output=True, timeout=10)

            result = check()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['routes'], 1)
            self.assertFalse((directory / 'reports').exists())
            self.assertFalse((directory / 'config').exists())
            self.assertEqual(pin.read_text(), '{"preserve":true}')
            self.assertNotIn('second-fixture', result.stdout)
            pin.write_text(json.dumps({**route, 'interface': None}))
            self.assertEqual(check('--select').returncode, 0)
            pin.write_text(json.dumps({**route, 'key_fingerprint': hashlib.sha256(b'first-fixture').hexdigest()}))
            self.assertNotEqual(check('--select').returncode, 0)
            self.assertFalse((directory / 'reports').exists())
            route['key_fingerprint'] = '0' * 64
            self.assertNotEqual(check().returncode, 0)
            route['key_fingerprint'] = hashlib.sha256(b'second-fixture').hexdigest()
            route['proxy']['url'] = 'file:///tmp/invalid'
            self.assertNotEqual(check().returncode, 0)


if __name__ == '__main__':
    unittest.main()
